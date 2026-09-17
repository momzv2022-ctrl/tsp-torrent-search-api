#!/usr/bin/env python3
"""tsp-scrape: ask public trackers how big a swarm really is.

Indexes report seeder counts they invented or measured years ago, and the
Worker cannot check from Cloudflare, which speaks no UDP. This asks a few
public trackers directly (BEP 15 scrape) and answers over plain HTTP on
loopback; the relay Worker in front of it holds the key and the tunnel.

    GET /scrape?h=<infohash>,<infohash>,...      up to 50 per request
    GET /healthz

    {"swarms": {"<infohash>": {
         "reports": [{"tracker": "tracker.opentrackr.org", "seeders": 1, "leechers": 1, "completed": 40}],
         "seeders": 1, "leechers": 1, "answered": 4}},
     "trackers": 5, "took_ms": 812}

Every tracker that answered gets a report of its own, because the trackers
disagree and the disagreement is the point: an announce bot registers tens of
thousands of peers for a torrent on one or two of them, and the largest number
is the one it planted. The Worker judges the reports. `completed` is the
tracker's own count of finished downloads, which the bot never adds to, or
null on a tracker that has never reported one here (open.demonii.com says 0
for everything). `seeders` and `leechers` are still the largest any tracker
gave, for a Worker older than the reports. `answered` is how many trackers
replied at all, so a swarm nobody knows reads 0/0 with `answered` above zero,
and a scrape that reached no tracker is left out. Results are kept for TTL
seconds per hash. No dependencies beyond Python 3.
"""
import json
import os
import random
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LISTEN = os.environ.get("TSP_SCRAPE_LISTEN", "127.0.0.1:8788")
TTL = int(os.environ.get("TSP_SCRAPE_TTL", "900"))
MOST = 50
TIMEOUT = float(os.environ.get("TSP_SCRAPE_TIMEOUT", "1.8"))
TRACKERS = [
    tuple(one.rsplit(":", 1))
    for one in os.environ.get(
        "TSP_SCRAPE_TRACKERS",
        "tracker.opentrackr.org:1337,tracker.torrent.eu.org:451,open.stealth.si:80,open.demonii.com:1337,exodus.desync.com:6969",
    ).split(",")
    if ":" in one
]

cache = {}
cache_lock = threading.Lock()
resolved = {}
resolved_lock = threading.Lock()
# Trackers that have ever reported a finished download here. One that has not
# (open.demonii.com answers 0 for every torrent) is not saying "nobody ever
# finished", it is saying nothing, and its zeros go out as null.
counts_completions = set()
counts_lock = threading.Lock()


def address(host, port):
    """A tracker's address, resolved once an hour; DNS is not part of every scrape."""
    with resolved_lock:
        hit = resolved.get(host)
        if hit and hit[0] > time.time():
            return hit[1]
    addr = (socket.gethostbyname(host), int(port))
    with resolved_lock:
        resolved[host] = (time.time() + 3600, addr)
    return addr


def scrape_one(host, port, hashes):
    """One tracker's answer for these hashes: {hash: (seeders, completed, leechers)}, or None."""
    try:
        addr = address(host, port)
    except OSError:
        return None
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT)
    try:
        tid = random.randint(0, 2**31 - 1)
        sock.sendto(struct.pack(">QII", 0x41727101980, 0, tid), addr)
        data, _ = sock.recvfrom(64)
        action, rtid, cid = struct.unpack(">IIQ", data[:16])
        if action != 0 or rtid != tid:
            return None
        tid = random.randint(0, 2**31 - 1)
        sock.sendto(struct.pack(">QII", cid, 2, tid) + b"".join(bytes.fromhex(h) for h in hashes), addr)
        data, _ = sock.recvfrom(8 + 12 * len(hashes) + 64)
        action, rtid = struct.unpack(">II", data[:8])
        if action != 2 or rtid != tid or len(data) < 8 + 12 * len(hashes):
            return None
        out = {}
        for i, h in enumerate(hashes):
            out[h] = struct.unpack(">III", data[8 + 12 * i : 20 + 12 * i])
        return out
    except (OSError, struct.error):
        return None
    finally:
        sock.close()


def measure(hashes):
    """Every tracker at once, each report kept, and the answer remembered."""
    now = time.time()
    swarms = {}
    todo = []
    with cache_lock:
        for h in hashes:
            hit = cache.get(h)
            if hit and hit[0] > now:
                swarms[h] = hit[1]
            else:
                todo.append(h)
    if todo:
        with ThreadPoolExecutor(max_workers=len(TRACKERS)) as pool:
            answers = [(host, one) for host, one in pool.map(lambda t: (t[0], scrape_one(t[0], t[1], todo)), TRACKERS) if one]
        with counts_lock:
            for host, one in answers:
                if any(completed > 0 for _, completed, _ in one.values()):
                    counts_completions.add(host)
            counting = set(counts_completions)
        for h in todo:
            reports = []
            for host, one in answers:
                if h not in one:
                    continue
                seeders, completed, leechers = one[h]
                reports.append({"tracker": host, "seeders": seeders, "leechers": leechers, "completed": completed if host in counting else None})
            if not reports:
                continue  # no tracker reached: say nothing rather than 0
            swarms[h] = {
                "reports": reports,
                "seeders": max(r["seeders"] for r in reports),
                "leechers": max(r["leechers"] for r in reports),
                "answered": len(reports),
            }
        with cache_lock:
            for h in todo:
                if h in swarms:
                    cache[h] = (now + TTL, swarms[h])
            if len(cache) > 50000:
                for stale in sorted(cache, key=lambda k: cache[k][0])[: len(cache) - 40000]:
                    del cache[stale]
    return swarms


class Handler(BaseHTTPRequestHandler):
    server_version = "tsp-scrape/2"

    def log_message(self, *_):
        pass

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz":
            return self.send_json(200, {"ok": True, "trackers": len(TRACKERS), "cached": len(cache), "counting": sorted(counts_completions)})
        if url.path != "/scrape":
            return self.send_json(404, {"error": "not found"})
        raw = parse_qs(url.query).get("h", [""])[0].lower()
        hashes = []
        for h in raw.split(","):
            if len(h) == 40 and all(c in "0123456789abcdef" for c in h) and h not in hashes:
                hashes.append(h)
        if not hashes:
            return self.send_json(400, {"error": "h must be infohashes, comma separated"})
        started = time.time()
        swarms = measure(hashes[:MOST])
        self.send_json(200, {"swarms": swarms, "trackers": len(TRACKERS), "took_ms": int((time.time() - started) * 1000)})


if __name__ == "__main__":
    host, port = LISTEN.rsplit(":", 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
