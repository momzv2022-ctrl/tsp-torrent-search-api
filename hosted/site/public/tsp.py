#VERSION: 1.0
#AUTHORS: tspsearch.dev
#
# qBittorrent search plugin for a TSP endpoint, the Torrent Search Protocol.
#
# Install: View > Search engine > Search plugins > Install a new one > Local
# file, and pick this file. The URL and the key below were filled in by the
# page that handed it to you; edit them to point it at another deployment.
#
# Outside qBittorrent, for a quick look from a terminal:
#
#     python3 -c "import tsp; tsp.tsp().search('big+buck+bunny')"

import json
import urllib.parse

try:
    from novaprinter import prettyPrinter
    from helpers import retrieve_url
except ImportError:
    import urllib.request

    def retrieve_url(url):
        # Cloudflare turns away Python's default user agent; qBittorrent's own helper sends a browser's.
        request = urllib.request.Request(url, headers={"User-Agent": "qBittorrent TSP plugin/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8", "replace")

    def prettyPrinter(row):
        print("|".join(str(row.get(field, "")).replace("|", " ") for field in ("link", "name", "size", "seeds", "leech", "engine_url", "desc_link")))


class tsp(object):
    url = "__TSP_URL__"
    apikey = "__TSP_KEY__"
    name = "TSP"
    supported_categories = {
        "all": "",
        "movies": "video",
        "tv": "video",
        "anime": "video",
        "music": "audio",
        "games": "software",
        "software": "software",
        "books": "document",
        "pictures": "image",
    }

    PAGE = 100
    PAGES = 3

    def search(self, what, cat="all"):
        params = {"q": urllib.parse.unquote_plus(what), "limit": str(self.PAGE), "apikey": self.apikey}
        if self.supported_categories.get(cat):
            params["cat"] = self.supported_categories[cat]

        seen = 0
        for page in range(self.PAGES):
            params["offset"] = str(page * self.PAGE)
            try:
                data = retrieve_url(self.url.rstrip("/") + "/api/v1/search?" + urllib.parse.urlencode(params))
            except Exception:
                return
            if isinstance(data, bytes):
                data = data.decode("utf-8", "replace")
            try:
                answer = json.loads(data)
            except ValueError:
                return

            torrents = answer.get("torrents") or []
            for torrent in torrents:
                link = torrent.get("magnet") or torrent.get("torrent_url")
                if not link:
                    continue
                prettyPrinter({
                    "link": link,
                    "name": torrent.get("name") or "",
                    "size": str(torrent.get("size_bytes") if torrent.get("size_bytes") is not None else -1),
                    "seeds": torrent.get("seeders", -1),
                    "leech": torrent.get("leechers", -1),
                    "engine_url": self.url,
                    "desc_link": torrent.get("description_url") or link,
                })
            seen += len(torrents)
            if not torrents or seen >= int(answer.get("count") or 0):
                return
