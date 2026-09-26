/**
 * The Worker, without a network.
 *
 * Everything here is exercised through the real entry point or the real
 * helpers, with `fetch` replaced by a function that answers from a table. The
 * point is that a descriptor, a feed and a request are the only inputs the
 * Worker has, and all three are data, so all three can be handed to it.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import worker, { __testing } from "../src/worker.js";

const {
  browseQuery,
  buildRequest,
  classifyName,
  coerce,
  descriptorProblem,
  keyMatches,
  merge,
  parseHtml,
  parseXml,
  pick,
  queryAll,
  readFeed,
  readRow,
  resetFeedMemo,
  rowsFrom,
  textOf,
  toBytes,
  toDate,
  toInfohash,
} = __testing;

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * The real catalogue, served as a feed.
 *
 * The source `worker.js` ships with an empty compiled catalogue on purpose,
 * `npm run build` splices it in, so a test that wants real indexes hands them
 * over the way a deployment gets them: from the feed. Which is also the path
 * worth testing, since it is the one every running Worker uses.
 */
function catalogueFeed(over = {}) {
  const dir = new URL("../../catalogue/", import.meta.url);
  const indexes = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(new URL(file, dir), "utf8")));
  return JSON.stringify({
    tsp_feed_version: 1,
    serial: 1,
    issued_at: "2026-09-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    indexes,
    ...over,
  });
}

/** Answer from a table of `url substring → { status, body }`; anything else is a refusal. */
function stubFetch(table) {
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    asked.push({ url: address, init });
    for (const [needle, answer] of Object.entries(table)) {
      if (address.includes(needle)) {
        if (answer instanceof Error) throw answer;
        return new Response(answer.body ?? "", { status: answer.status ?? 200 });
      }
    }
    return new Response("no", { status: 404 });
  };
  return asked;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetFeedMemo();
});

const call = (path, env = {}) => worker.fetch(new Request(`https://w.example${path}`), env, { waitUntil() {} });

// --- the descriptor language -------------------------------------------------

test("a descriptor must be something a Worker can safely run", () => {
  const good = {
    id: "example",
    kind: "json",
    origins: ["https://api.example"],
    request: { path: "/s", query: { q: "{q}" } },
    fields: { name: "title", infohash: "hash" },
  };
  assert.equal(descriptorProblem(good), "");

  const rejects = {
    "id must be lowercase letters, digits and dashes": { ...good, id: "Example!" },
    "origin http://api.example is not https": { ...good, origins: ["http://api.example"] },
    "origins must be a non-empty array": { ...good, origins: [] },
    "only json indexes may POST": { ...good, kind: "rss", request: { method: "POST" } },
    "fields.name is required: a row without a name is not a result": { ...good, fields: { infohash: "hash" } },
    "fields must yield an infohash or a magnet": { ...good, fields: { name: "title" } },
    "unknown field nope": { ...good, fields: { ...good.fields, nope: "x" } },
    "html indexes must say where the rows are": { ...good, kind: "html", rows: "" },
  };
  for (const [problem, descriptor] of Object.entries(rejects)) {
    assert.equal(descriptorProblem(descriptor), problem);
  }
});

test("a bad regular expression in a descriptor is caught, not thrown at runtime", () => {
  const problem = descriptorProblem({
    id: "example",
    kind: "json",
    origins: ["https://api.example"],
    fields: { name: { from: "t", re: "([unclosed" }, infohash: "h" },
  });
  assert.match(problem, /re is not a valid pattern/);
});

// --- reading pages -----------------------------------------------------------

test("the HTML parser survives the markup these sites actually emit", () => {
  const tree = parseHtml(`
    <table id="t"><tr><td class="n"><a href='/x'>One
      <tr><td class="n"><a href='/y'>Two
    </table>
    <script>var broken = "<tr><td>not a row";</script>
    <!-- <tr><td>nor this -->`);
  const rows = queryAll(tree, "table#t tr");
  assert.equal(rows.length, 2, "unclosed rows still close each other");
  assert.equal(textOf(rows[0]), "One");
  assert.equal(queryAll(rows[1], "td.n a")[0].attrs.href, "/y");
});

test("attribute selectors accept either kind of quote, or none", () => {
  const tree = parseHtml(`<div><a href="magnet:?xt=1">m</a><a href="/torrent/9">d</a></div>`);
  for (const selector of [`a[href^='magnet:']`, `a[href^="magnet:"]`, `a[href^=magnet:]`]) {
    assert.equal(queryAll(tree, selector).length, 1, selector);
  }
  assert.equal(queryAll(tree, "a[href]").length, 2);
});

test("XML keeps its case, its prefixes and its CDATA", () => {
  const tree = parseXml(`<rss><channel><item>
      <title><![CDATA[Big & Small]]></title>
      <nyaa:seeders>12</nyaa:seeders>
      <enclosure url="magnet:?xt=urn:btih:aa" />
      <attr name="peers" value="3"/>
    </item></channel></rss>`);
  const [item] = rowsFrom("rss", `<rss><channel><item/></channel></rss>`, "rss/channel/item").length
    ? queryAllItems(tree)
    : [];
  function queryAllItems(root) {
    const found = [];
    const walk = (node) => {
      if (node.tag === "item") found.push(node);
      node.children.forEach((child) => child.children && walk(child));
    };
    walk(root);
    return found;
  }
  assert.equal(pick(item, "title", "rss"), "Big & Small");
  assert.equal(pick(item, "nyaa:seeders", "rss"), "12");
  assert.equal(pick(item, "enclosure@url", "rss"), "magnet:?xt=urn:btih:aa");
  assert.equal(pick(item, "attr[name=peers]@value", "rss"), "3");
});

test("a cell can be picked by position when there is nothing to select by", () => {
  const [row] = queryAll(parseHtml("<table><tr><td>name<td>1.5 GiB<td>44</table>"), "tr");
  assert.equal(pick(row, { cell: 2 }, "html"), "1.5 GiB");
  assert.equal(pick(row, { cell: -1 }, "html"), "44");
});

test("nested JSON rows can still see what they came out of", () => {
  const body = JSON.stringify({ data: { movies: [{ title: "Sintel", torrents: [{ hash: "a".repeat(40) }] }] } });
  const [row] = rowsFrom("json", body, "data.movies[].torrents[]");
  assert.equal(pick(row, "^.title", "json"), "Sintel");
  assert.equal(pick(row, "hash", "json"), "a".repeat(40));
});

// --- values ------------------------------------------------------------------

test("sizes, counts, hashes and dates arrive in whatever shape the site likes", () => {
  assert.equal(toBytes("1.5 GiB"), 1610612736);
  assert.equal(toBytes("700 MB"), 7e8);
  assert.equal(toBytes(1073741824), 1073741824);
  assert.equal(toBytes("n/a"), undefined);

  assert.equal(toInfohash("magnet:?xt=urn:btih:" + "AB".repeat(20) + "&dn=x"), "ab".repeat(20));
  assert.equal(toInfohash("/details/" + "f".repeat(40)), "f".repeat(40));
  assert.equal(toInfohash("nothing here"), undefined);

  const now = Date.parse("2026-09-09T12:00:00Z");
  assert.equal(toDate("2 days ago", now), "2026-09-07T12:00:00.000Z");
  assert.equal(toDate("Jan 5, 2024", now), "2024-01-05T00:00:00.000Z");
  assert.equal(toDate(1788955200, now), "2026-09-09T12:00:00.000Z");

  assert.equal(coerce("category", "cheese", {}), undefined, "an unknown category is dropped, not passed on");
  assert.equal(coerce("description_url", "/x", { origin: "https://s.example" }), "https://s.example/x");
});

test("a field spec can fall back, extract, map and template", () => {
  const row = { a: "", b: "id-42", cat: "301", size: 0 };
  assert.equal(pick(row, ["a", "b"], "json"), "id-42");
  assert.equal(pick(row, { from: "b", re: "(\\d+)" }, "json"), "42");
  assert.equal(pick(row, { from: "cat", prefix: 1, map: { 3: "software" } }, "json"), "software");
  assert.equal(pick(row, { from: "b", template: "https://s/{value}" }, "json"), "https://s/id-42");
  assert.equal(pick(row, { from: "size", nonzero: true }, "json"), undefined);
});

test("an index's empty-result placeholder is not a result", () => {
  // apibay answers a miss with one row: name "No results returned", hash of
  // forty zeros. A client showed it as a torrent. Forty zeros is nobody's.
  assert.equal(toInfohash("0000000000000000000000000000000000000000"), undefined);
  assert.equal(toInfohash("magnet:?xt=urn:btih:0000000000000000000000000000000000000000"), undefined);
  const descriptor = { id: "tpb", kind: "json", origins: ["https://x.example"], fields: { name: "name", infohash: "info_hash" } };
  assert.equal(readRow(descriptor, { name: "No results returned", info_hash: "0".repeat(40) }, "https://x.example", 0), null);
});

test("a row without a name or a hash is not a result", () => {
  const descriptor = { id: "x", kind: "json", origins: ["https://s.example"], fields: { name: "n", infohash: "h" } };
  assert.equal(readRow(descriptor, { h: "a".repeat(40) }, "https://s.example", Date.now()), null);
  assert.equal(readRow(descriptor, { n: "thing" }, "https://s.example", Date.now()), null);

  const row = readRow(descriptor, { n: "thing", h: "a".repeat(40) }, "https://s.example", Date.now());
  assert.equal(row.name, "thing");
  assert.match(row.magnet, /^magnet:\?xt=urn:btih:a{40}&dn=thing$/, "a magnet is built when the site gives only a hash");
});

// --- merging -----------------------------------------------------------------

test("a POST body's {limit} is a number, and a quote in the query cannot break the JSON", () => {
  // Knaben answered 422 to `"size": "100"`; the fix is the number JSON has.
  const descriptor = { id: "p", kind: "json", origins: ["https://p.example"], request: { method: "POST", path: "/v1", body: { query: "{q}", size: "{limit}", note: "up to {limit}" } }, fields: { name: "n", infohash: "h" } };
  const { init } = buildRequest(descriptor, "https://p.example", 'west "life"', { limit: 100, userAgent: "ua" });
  const body = JSON.parse(init.body);
  assert.equal(body.size, 100);
  assert.equal(body.note, "up to 100", "inside a longer string it stays text");
  assert.equal(body.query, 'west "life"');
});

test("an index that ignores the query is held to the name, if its descriptor says so", async () => {
  // EZTV's API answers every query with its latest uploads, so a search for a
  // band came back as that week's television.
  const rows = JSON.stringify([{ n: "Star Trek Strange New Worlds S04E08", h: "a".repeat(40) }, { n: "Westlife - Gravity (2010)", h: "b".repeat(40) }]);
  const feed = feedBody({ indexes: [{ id: "lazy", kind: "json", origins: ["https://lazy.example"], match: "name", fields: { name: "n", infohash: "h" } }] });
  stubFetch({ "feed.json": { body: feed }, "lazy.example": { body: rows } });
  const body = await (await call("/api/v1/search?q=westlife")).json();
  assert.deepEqual(body.torrents.map((t) => t.name), ["Westlife - Gravity (2010)"]);

  const both = await (await call("/api/v1/search?q=star+trek")).json();
  assert.equal(both.count, 1, "every word of the query, in any case, with separators folded");

  assert.equal(descriptorProblem({ id: "x", kind: "json", origins: ["https://x.example"], match: "title", fields: { name: "n", infohash: "h" } }), 'match must be "name", or absent');
});

test("an apostrophe joins a word for the name filter, on both sides", async () => {
  // "I'm Game (2026)" read as `i m game`, so a search for `im game` dropped
  // every 1TamilMV row of the film.
  const rows = JSON.stringify([
    { n: "www.1TamilMV.meme - I'm Game (2026) Malayalam HQ PreDVD - 1080p", h: "a".repeat(40) },
    { n: "Im Game (2026) 720p Telugu DVDScr", h: "b".repeat(40) },
    { n: "Game of Thrones S08", h: "c".repeat(40) },
  ]);
  const feed = feedBody({ indexes: [{ id: "lazy", kind: "json", origins: ["https://lazy.example"], match: "name", fields: { name: "n", infohash: "h" } }] });
  stubFetch({ "feed.json": { body: feed }, "lazy.example": { body: rows } });
  for (const q of ["im+game", "I%27m+game", "I%E2%80%99m+game"]) {
    const body = await (await call(`/api/v1/search?q=${q}`)).json();
    assert.deepEqual(body.torrents.map((t) => t.infohash).sort(), ["a".repeat(40), "b".repeat(40)], q);
  }
});

test("the same torrent from two indexes becomes one row that names both", () => {
  const hash = "d".repeat(40);
  const rows = merge([
    { id: "one", rows: [{ indexer: "one", infohash: hash, name: "A", seeders: 10, size_bytes: 100 }] },
    { id: "two", rows: [{ indexer: "two", infohash: hash, name: "A", seeders: 50, first_seen: "2026-01-01T00:00:00Z" }] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seeders, 50, "the better-seeded row wins the numbers");
  assert.equal(rows[0].size_bytes, 100, "but a fact only one index had is kept");
  assert.deepEqual(rows[0].indexers.sort(), ["one", "two"]);
});

// --- the feed ----------------------------------------------------------------

const feedBody = (over = {}) =>
  JSON.stringify({
    tsp_feed_version: 1,
    serial: 7,
    issued_at: "2026-09-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    indexes: [{ id: "fed", kind: "json", origins: ["https://fed.example"], fields: { name: "n", infohash: "h" } }],
    ...over,
  });

test("a feed is believed only if it is the right kind of document, and current", () => {
  const now = Date.parse("2026-09-09T00:00:00Z");
  assert.equal(readFeed(feedBody(), now).serial, 7);
  assert.equal(readFeed("not json", now), null);
  assert.equal(readFeed(feedBody({ tsp_feed_version: 2 }), now), null);
  assert.equal(readFeed(feedBody({ expires_at: "2026-01-01T00:00:00Z" }), now), null);
  assert.equal(readFeed(feedBody({ serial: -1 }), now), null);
  assert.equal(readFeed(feedBody({ indexes: [] }), now), null);
  assert.equal(readFeed(feedBody({ indexes: [{ id: "bad" }] }), now), null, "a feed of only invalid indexes is no feed");
});

test("a malformed index in an otherwise good feed is dropped, not fatal", () => {
  const feed = readFeed(feedBody({ indexes: [{ id: "bad" }, JSON.parse(feedBody()).indexes[0]] }), Date.now());
  assert.equal(feed.indexes.length, 1);
  assert.equal(feed.indexes[0].id, "fed");
});

test("the Worker runs the feed's catalogue, not the one compiled into it", async () => {
  stubFetch({ "feed.json": { body: feedBody() } });
  const health = await (await call("/api/v1/health")).json();
  assert.equal(health.catalogue.source, "feed");
  assert.equal(health.catalogue.serial, 7);
  assert.equal(health.indexes.known, 1);
});

test("an unreachable feed leaves the compiled catalogue in charge", async () => {
  // The built artifact, not the source: the compiled catalogue is what
  // `npm run build` splices in, and this is the only test that cares.
  const built = await import(new URL("../../docs/worker.js", import.meta.url));
  stubFetch({ "feed.json": { status: 503 } });
  const answer = await built.default.fetch(new Request("https://w.example/api/v1/health"), {}, { waitUntil() {} });
  const health = await answer.json();
  assert.equal(health.catalogue.source, "compiled");
  assert.ok(health.indexes.known >= 14, "the compiled catalogue is the fallback, and it is not empty");
  built.__testing.resetFeedMemo();
});

test("a running deployment picks up a new serial within the hour, and never goes back", async (t) => {
  // This is the promise the whole design rests on, a Worker deployed today
  // searches whatever the feed says next month, so it is exercised the way
  // it happens: one isolate, requests an hour apart, the feed moving under it.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-09T00:00:00Z") });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const serial = async () => (await (await call("/api/v1/health")).json()).catalogue.serial;

  const asked = stubFetch({ "feed.json": { body: feedBody({ serial: 7 }) } });
  assert.equal(await serial(), 7);

  stubFetch({ "feed.json": { body: feedBody({ serial: 8 }) } });
  assert.equal(await serial(), 7, "within the hour the memo answers and nothing is fetched");

  t.mock.timers.setTime(Date.parse("2026-09-09T01:00:01Z"));
  assert.equal(await serial(), 7, "the first request past the hour is answered from the memo while the feed refreshes behind it");
  await settle();
  assert.equal(await serial(), 8, "and the next one has the new catalogue");

  const replay = stubFetch({ "feed.json": { body: feedBody({ serial: 5 }) } });
  t.mock.timers.setTime(Date.parse("2026-09-09T02:00:02Z"));
  await serial();
  await settle();
  assert.equal(await serial(), 8, "a feed with a lower serial is a replay, and is not believed");
  assert.ok(replay.length >= 1, "it was fetched and rejected, not ignored");

  stubFetch({ "feed.json": { status: 503 } });
  t.mock.timers.setTime(Date.parse("2026-09-09T03:00:03Z"));
  await serial();
  await settle();
  assert.equal(await serial(), 8, "an outage at the feed keeps the last good catalogue");
  assert.ok(asked.length >= 1);
});

test("TSP_FEED=0 pins the compiled catalogue and asks for nothing", async () => {
  const asked = stubFetch({ "feed.json": { body: feedBody() } });
  const health = await (await call("/api/v1/health", { TSP_FEED: "0" })).json();
  assert.equal(health.catalogue.source, "compiled");
  assert.equal(asked.length, 0);
});

// --- routes ------------------------------------------------------------------

test("the key is required, accepted three ways, and compared in constant time", async () => {
  assert.equal(keyMatches("abc", "abc"), true);
  assert.equal(keyMatches("abd", "abc"), false);
  assert.equal(keyMatches("ab", "abc"), false);
  assert.equal(keyMatches("", ""), true, "no key configured means the deployment is open on purpose");

  stubFetch({ "feed.json": { status: 404 } });
  assert.equal((await call("/api/v1/indexers", { TSP_APIKEY: "sec" })).status, 401);
  assert.equal((await call("/api/v1/indexers?apikey=sec", { TSP_APIKEY: "sec" })).status, 200);

  const header = await worker.fetch(
    new Request("https://w.example/api/v1/indexers", { headers: { "x-api-key": "sec" } }),
    { TSP_APIKEY: "sec" },
    { waitUntil() {} },
  );
  assert.equal(header.status, 200);

  const bearer = await worker.fetch(
    new Request("https://w.example/api/v1/indexers", { headers: { authorization: "Bearer sec" } }),
    { TSP_APIKEY: "sec" },
    { waitUntil() {} },
  );
  assert.equal(bearer.status, 200);
});

test("health needs no key, it is how you check a deployment you cannot log into", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  assert.equal((await call("/api/v1/health", { TSP_APIKEY: "sec" })).status, 200);
});

test("a search asks every enabled index and merges what comes back", async () => {
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "apibay.org": { body: fixture("piratebay.json") },
    "torrents-csv.com": { body: fixture("torrentscsv.json") },
    "knaben": { body: fixture("knaben.json") },
  });

  const answer = await call("/api/v1/search?q=big+buck+bunny&indexers=piratebay,torrentscsv,knaben");
  assert.equal(answer.status, 200);
  const body = await answer.json();

  assert.equal(body.query, "big buck bunny");
  assert.ok(body.torrents.length > 0);
  assert.deepEqual(body.engines.sort(), ["knaben", "piratebay", "torrentscsv"]);

  const shared = body.torrents.find((torrent) => torrent.sources.length > 1);
  assert.ok(shared, "the same release from three indexes should collapse into one row");
  assert.ok(shared.magnet.startsWith("magnet:?xt=urn:btih:"));
  assert.ok(shared.scraped_at);
});

test("TSP_TIMEOUT is the wait for one index, all of its mirrors together", async () => {
  // Four mirrors that each hang used to cost four timeouts in a row; a
  // search was as slow as that. Now a mirror that hangs uses the index's
  // whole turn, and the rest are not tried.
  const feed = feedBody({ indexes: [{ id: "slow", kind: "json", origins: ["https://m1.example", "https://m2.example", "https://m3.example"], fields: { name: "n", infohash: "h" } }] });
  const hang = (url, init) => new Promise((resolve, reject) => {
    if (String(url).includes("feed.json")) return resolve(new Response(feed));
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  globalThis.fetch = hang;
  const started = Date.now();
  const body = await (await call("/api/v1/search?q=anything", { TSP_TIMEOUT: "1" })).json();
  const took = Date.now() - started;
  assert.ok(took < 2500, `took ${took} ms; one clock for the index, not one per mirror`);
  assert.equal(body.count, 0);
  assert.match(body.failures.slow[0], /timed out/);
  assert.match(body.failures.slow[1], /not tried, no time left/);
});

test("an index that fails is reported, and does not fail the search", async () => {
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "apibay.org": { body: fixture("piratebay.json") },
    "torrents-csv.com": { status: 500 },
  });
  const body = await (await call("/api/v1/search?q=x&indexers=piratebay,torrentscsv")).json();
  assert.deepEqual(body.engines, ["piratebay"]);
  assert.match(body.failures.torrentscsv[0], /answered 500/);
  assert.ok(body.torrents.length > 0);
});

test("limit, offset and min_seeders are applied to the merged rows", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "apibay.org": { body: fixture("piratebay.json") } });
  const all = await (await call("/api/v1/search?q=x&indexers=piratebay")).json();
  const one = await (await call("/api/v1/search?q=x&indexers=piratebay&limit=1")).json();
  assert.equal(one.torrents.length, 1);
  assert.equal(one.count, all.count, "count is what matched, not what fitted on the page");

  const seeded = await (await call("/api/v1/search?q=x&indexers=piratebay&min_seeders=1000000")).json();
  assert.equal(seeded.torrents.length, 0);
});

test("sort=recent is newest first, sort=size largest first, and a page may be longer than one index's share", async () => {
  // Every ordering used to be the swarm order, so a client asking for the
  // newest releases got them last, behind every row with a count.
  const rows = JSON.stringify([
    { n: "Old But Loud", h: "a".repeat(40), s: 900, d: "2019-01-01", z: 100 },
    { n: "Newest, Uncounted", h: "b".repeat(40), d: "2026-09-19", z: 200 },
    { n: "New, Seeded", h: "c".repeat(40), s: 50, d: "2026-09-01", z: 300 },
  ]);
  const feed = feedBody({ indexes: [{ id: "one", kind: "json", origins: ["https://one.example"], fields: { name: "n", infohash: "h", seeders: "s", first_seen: "d", size_bytes: "z" } }] });
  stubFetch({ "feed.json": { body: feed }, "one.example": { body: rows } });

  const names = async (query) => (await (await call(`/api/v1/search?q=x&${query}`)).json()).torrents.map((t) => t.name);
  assert.deepEqual(await names(""), ["Old But Loud", "New, Seeded", "Newest, Uncounted"], "the swarm order, still the default");
  assert.deepEqual(await names("sort=recent"), ["Newest, Uncounted", "New, Seeded", "Old But Loud"]);
  assert.deepEqual(await names("sort=size"), ["New, Seeded", "Newest, Uncounted", "Old But Loud"]);
  assert.deepEqual(await names("sort=bogus"), await names(""), "an ordering it does not know is the default");

  const page = await (await call("/api/v1/search?q=x&limit=500")).json();
  assert.equal(page.limit, 200, "capped at a page, not at one index's hundred");
});

test("/api/v1/try runs a descriptor that is not in the catalogue", async () => {
  stubFetch({ "feed.json": { status: 404 }, "new.example": { body: JSON.stringify([{ n: "Thing", h: "c".repeat(40) }]) } });
  const descriptor = { id: "new", kind: "json", origins: ["https://new.example"], rows: "", fields: { name: "n", infohash: "h" } };
  const body = await (await call(`/api/v1/try?d=${encodeURIComponent(JSON.stringify(descriptor))}&q=thing`)).json();
  assert.equal(body.count, 1);
  assert.equal(body.rows[0].name, "Thing");

  const bad = await call(`/api/v1/try?d=${encodeURIComponent(JSON.stringify({ id: "x" }))}`);
  assert.equal(bad.status, 400);
});

test("indexers lists what is known and says which of them are on", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const body = await (await call("/api/v1/indexers")).json();
  const piratebay = body.indexers.find((one) => one.id === "piratebay");
  assert.equal(piratebay.upstream, "thepiratebay");
  assert.equal(piratebay.enabled, true);
  assert.ok(body.indexers.some((one) => one.enabled === false), "the off-by-default ones are listed too");
});

test("adult indexes are searched by default, and TSP_NSFW=0 holds them back", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const sukebei = (list) => list.indexers.find((one) => one.id === "sukebei");

  const byDefault = await (await call("/api/v1/indexers")).json();
  assert.equal(sukebei(byDefault).enabled, true, "whoever deployed this chose to; it is their search API");

  const held = await (await call("/api/v1/indexers", { TSP_NSFW: "0" })).json();
  assert.equal(sukebei(held).enabled, false);

  const stillOn = await (await call("/api/v1/indexers", { TSP_NSFW: "1" })).json();
  assert.equal(sukebei(stillOn).enabled, true);
});

test("an index says whether it is adult, whether or not it is searched", async () => {
  // The gate is a deployment's choice; the fact is the index's. A caller that
  // wants to filter on it needs it either way.
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const body = await (await call("/api/v1/indexers", { TSP_NSFW: "0" })).json();
  const sukebei = body.indexers.find((one) => one.id === "sukebei");
  assert.equal(sukebei.enabled, false);
  assert.ok(catalogueFeed().includes('"nsfw":true'), "and the feed carries the fact");
});

test("the front page shows the URL and, by default, the key to anyone who opens it", async () => {
  // The page has to be public, a deployment only its key-holder could check
  // is a deployment nobody can check. The first version of it showed the key
  // only to a request that already carried it; the person who had just
  // deployed then opened the URL Cloudflare gave them and saw dots. A
  // workers.dev address has a random suffix and is not guessable, so the
  // default is now to show it, and TSP_SHOW_KEY=0 is the stricter page.
  stubFetch({ "feed.json": { status: 404 } });
  const page = await (await call("/", { TSP_APIKEY: "the-key" })).text();
  assert.match(page, /https:\/\/w\.example/, "its own URL is public");
  assert.match(page, /the-key/, "and so, by default, is its key");
  assert.match(page, /TSP_SHOW_KEY=0/, "with a word about how to hide it");
  assert.match(page, /api\/v1\/search\?q=ubuntu&amp;apikey=the-key/, "the example search is one you can click");
});

test("TSP_SHOW_KEY=0 shows the key only to a request that already has it", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const env = { TSP_APIKEY: "the-key", TSP_SHOW_KEY: "0" };
  const page = await (await call("/", env)).text();
  assert.ok(!page.includes("the-key"), "a visitor without the key does not get it");
  assert.match(page, /add \?apikey=/);

  const holder = await (await call("/?apikey=the-key", env)).text();
  assert.match(holder, /the-key/, "confirming a key you hold is the point of the page");

  const wrong = await (await call("/?apikey=nope", env)).text();
  assert.ok(!wrong.includes("the-key"));
});

test("an open deployment says so rather than pretending to have a key", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const page = await (await call("/")).text();
  assert.match(page, /open to anyone who finds it/);
});

// --- browsing ----------------------------------------------------------------

test("an empty query becomes a real one, chosen for the category asked for", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "torrents-csv.com": { body: fixture("torrentscsv.json") } });
  const body = await (await call("/api/v1/search?q=&cat=audio&indexers=torrentscsv")).json();
  assert.ok(["flac", "mp3", "discography"].includes(body.browse_query), `audio should browse an audio term, got ${body.browse_query}`);

  const video = await (await call("/api/v1/search?q=&cat=video&indexers=torrentscsv")).json();
  assert.ok(["2160p", "1080p", "x265"].includes(video.browse_query));
});

test("the browse term rotates, so a browse is not always the same page", () => {
  const hour = 60 * 60 * 1000;
  const at = (n) => browseQuery("audio", n * hour);
  const seen = new Set([at(0), at(1), at(2), at(3)]);
  assert.ok(seen.size > 1, "three audio terms should not collapse to one");
  assert.equal(at(0), at(3), "and it should come back round");
});

test("a browsed search says it was browsing", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "torrents-csv.com": { body: fixture("torrentscsv.json") } });
  const asked = await (await call("/api/v1/search?q=ubuntu&indexers=torrentscsv")).json();
  assert.equal(asked.browse_query, undefined, "a real query is not a browse");

  const browsed = await (await call("/api/v1/search?q=&indexers=torrentscsv")).json();
  assert.ok(browsed.browse_query, "rows nobody asked for have to explain themselves");
});

test("TSP_BROWSE=0 keeps the strict reading: an empty query, an empty answer", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "torrents-csv.com": { body: fixture("torrentscsv.json") } });
  const body = await (await call("/api/v1/search?q=", { TSP_BROWSE: "0" })).json();
  assert.equal(body.count, 0);
  assert.deepEqual(body.torrents, []);
  assert.equal(body.browse_query, undefined);
});

test("the shape of the API is fixed: OPTIONS, wrong method, unknown path", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  assert.equal((await worker.fetch(new Request("https://w.example/", { method: "OPTIONS" }), {}, {})).status, 204);
  assert.equal((await worker.fetch(new Request("https://w.example/", { method: "POST" }), {}, {})).status, 405);
  assert.equal((await call("/nope")).status, 404);
});

// --- categories --------------------------------------------------------------

test("upstream's category words are not TSP's, and are translated rather than copied", async () => {
  // The bug this exists to prevent: an index whose upstream entry says it
  // covers `Other` stamped the literal word "other" on every row, so a
  // DHT crawl full of music came back uncategorised. "Anime" and "porn"
  // leaked through the same way, and neither is a TSP category at all.
  const dir = new URL("../../catalogue/", import.meta.url);
  const now = Date.parse("2026-09-09T00:00:00Z");

  for (const file of readdirSync(dir).filter((one) => one.endsWith(".json"))) {
    const descriptor = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const body = readFileSync(new URL(`./fixtures/${descriptor.fixture}`, import.meta.url), "utf8");
    const rows = rowsFrom(descriptor.kind, body, descriptor.rows)
      .map((row) => readRow(descriptor, row, descriptor.origins[0], now))
      .filter(Boolean);

    for (const row of rows) {
      if (row.category === undefined) continue;
      assert.ok(__testing.CATEGORIES.has(row.category), `${descriptor.id} emitted "${row.category}", which is not a TSP category`);
    }
  }
});

test("a release name is read when the index does not say", () => {
  assert.equal(classifyName("Backstreet Boys - DNA (2019) [FLAC] VT88"), "audio");
  assert.equal(classifyName("Backstreet Boys - The Essential (Mp3 320kbps Quality Songs)"), "audio");
  assert.equal(classifyName("Metallica Discography 1983-2023"), "audio");
  assert.equal(classifyName("The.Last.of.Us.S01E03.1080p.WEB-DL"), "video");
  assert.equal(classifyName("Elden Ring [FitGirl Repack]"), "software");
  assert.equal(classifyName("Clean Code - Robert Martin [PDF]"), "document");
});

test("a name with no marker gets no category, rather than a wrong one", () => {
  // Saying nothing is the honest answer, and a caller filtering by category
  // must keep these, otherwise the filter deletes correct answers.
  assert.equal(classifyName("Backstreet Boys"), null);
  assert.equal(classifyName("The Beatles - Abbey Road"), null);
  assert.equal(classifyName(""), null);
});

test("a version number is not a bitrate, and a comic is not an album", () => {
  assert.equal(classifyName("Adobe Photoshop v2 x64"), "software");
  assert.equal(classifyName("Batman Comics CBR Collection"), "document");
  assert.equal(classifyName("Album [MP3 V0]"), "audio", "the LAME preset still counts next to a format");
});

test("what the index says about a row outranks what the name suggests", () => {
  const descriptor = {
    id: "x",
    kind: "json",
    origins: ["https://s.example"],
    categories: ["anime"],
    fields: { name: "n", infohash: "h", category: { const: "audio" } },
  };
  const row = readRow(descriptor, { n: "Some Show 1080p BluRay", h: "a".repeat(40) }, "https://s.example", Date.now());
  assert.equal(row.category, "audio", "the index's own word wins");

  const noWord = { ...descriptor, fields: { name: "n", infohash: "h" } };
  const guessed = readRow(noWord, { n: "Some Show 1080p BluRay", h: "b".repeat(40) }, "https://s.example", Date.now());
  assert.equal(guessed.category, "video", "then the name, which is about this row");

  const bare = readRow(noWord, { n: "Some Show", h: "c".repeat(40) }, "https://s.example", Date.now());
  assert.equal(bare.category, "video", "then the site, anime is a kind of video, not a kind of file");
});

test("an index that says it does not classify gets no category, not the word \"other\"", () => {
  // torrents-csv is the case that made this visible: upstream records it as
  // covering `Other`, and the shortcut stamped that on every album it returned.
  const descriptor = { id: "csv", kind: "json", origins: ["https://s.example"], categories: ["other"], fields: { name: "n", infohash: "h" } };
  const bare = readRow(descriptor, { n: "Backstreet Boys", h: "a".repeat(40) }, "https://s.example", Date.now());
  assert.equal(bare.category, undefined, "nobody could tell, and the row should say so by staying silent");

  const flac = readRow(descriptor, { n: "Backstreet Boys - DNA (2019) [FLAC]", h: "b".repeat(40) }, "https://s.example", Date.now());
  assert.equal(flac.category, "audio");
});

test("a deployment can say which build it is running", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const source = await (await call("/api/v1/health")).json();
  assert.equal(source.build, "source", "the unbuilt source says so");

  const built = await import(new URL("../../docs/worker.js", import.meta.url));
  const answer = await built.default.fetch(new Request("https://w.example/api/v1/health"), {}, { waitUntil() {} });
  assert.match((await answer.json()).build, /^[0-9a-f]{12}$/, "the published file carries its own hash");
  built.__testing.resetFeedMemo();
});

test("the front page marks an adult index as one", async () => {
  // It is in the default set, so the page that lists what a deployment
  // searches should say which of them that is, learning it from the results
  // is worse.
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const page = await (await call("/")).text();
  assert.match(page, /Sukebei<\/a> <span class="k">adult<\/span>/);
});

// --- hosted mode ---------------------------------------------------------------

const HOSTED = { TSP_KEY_SECRET: "s3cret" };
const callFrom = (path, env, ip) => worker.fetch(new Request(`https://w.example${path}`, { headers: { "cf-connecting-ip": ip } }), env, { waitUntil() {} });

test("a hosted deployment mints a signed key for whoever asks, and honours it", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const minted = await (await call("/api/v1/key", HOSTED)).json();
  assert.match(minted.apikey, /^[0-9a-f]{24}\.[0-9a-f]{32}$/);
  assert.equal(minted.url, "https://w.example");
  assert.match(minted.example, /apikey=/);

  assert.equal((await call(`/api/v1/indexers?apikey=${minted.apikey}`, HOSTED)).status, 200);
  assert.equal((await call("/api/v1/indexers", HOSTED)).status, 401, "no key, no search");
  const forged = `${minted.apikey.slice(0, 24)}.${"0".repeat(32)}`;
  assert.equal((await call(`/api/v1/indexers?apikey=${forged}`, HOSTED)).status, 401, "a wrong signature is a wrong key");
  const other = await (await call("/api/v1/key", { TSP_KEY_SECRET: "another" })).json();
  assert.equal((await call(`/api/v1/indexers?apikey=${other.apikey}`, HOSTED)).status, 401, "a key signed under another secret is not this deployment's");

  const posted = await worker.fetch(new Request("https://w.example/api/v1/key", { method: "POST" }), HOSTED, { waitUntil() {} });
  assert.equal(posted.status, 200, "the front page's button POSTs");
  const elsewhere = await worker.fetch(new Request("https://w.example/api/v1/search", { method: "POST" }), HOSTED, { waitUntil() {} });
  assert.equal(elsewhere.status, 405, "and nothing else takes a POST");
  assert.equal((await (await call("/api/v1/health", HOSTED)).json()).mode, "hosted");
});

test("a single-key deployment does not mint; it has the one key it was given", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  assert.equal((await call("/api/v1/key", { TSP_APIKEY: "sec" })).status, 404);
  assert.equal((await call("/api/v1/key")).status, 404);
});

test("a denied key id is refused, and a new secret refuses them all", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const { apikey } = await (await call("/api/v1/key", HOSTED)).json();
  const id = apikey.split(".")[0];
  assert.equal((await call(`/api/v1/indexers?apikey=${apikey}`, { ...HOSTED, TSP_KEY_DENY: `abc, ${id}` })).status, 401);
  assert.equal((await call(`/api/v1/indexers?apikey=${apikey}`, { ...HOSTED, TSP_KEY_DENY: "abc" })).status, 200);
  assert.equal((await call(`/api/v1/indexers?apikey=${apikey}`, { TSP_KEY_SECRET: "rotated" })).status, 401);
});

test("the operator's key is above the signed ones, and alone may run a descriptor", async () => {
  stubFetch({ "feed.json": { status: 404 }, "new.example": { body: JSON.stringify([{ n: "Thing", h: "c".repeat(40) }]) } });
  const env = { ...HOSTED, TSP_ADMIN_KEY: "op" };
  const descriptor = { id: "new", kind: "json", origins: ["https://new.example"], rows: "", fields: { name: "n", infohash: "h" } };
  const d = encodeURIComponent(JSON.stringify(descriptor));
  const { apikey } = await (await call("/api/v1/key", env)).json();

  assert.equal((await call(`/api/v1/try?d=${d}&apikey=${apikey}`, env)).status, 403, "a key from the front page fetches nothing of its choosing");
  assert.equal((await call(`/api/v1/relay?d=${d}&apikey=${apikey}`, env)).status, 403);
  assert.equal((await call(`/api/v1/try?d=${d}&apikey=op`, env)).status, 200);
  assert.equal((await call("/api/v1/indexers?apikey=op", env)).status, 200, "and it searches like any key");
  assert.equal((await call(`/api/v1/try?d=${d}&apikey=x`, { TSP_APIKEY: "x" })).status, 200, "a single-key deployment is its owner's, and try stays open to the key");
});

test("the hosted front page hands out keys and shows none", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const page = await (await call("/", { ...HOSTED, TSP_APIKEY: "never-shown" })).text();
  assert.match(page, /Get a key/);
  assert.match(page, /api\/v1\/key/);
  assert.ok(!page.includes("never-shown"));
  assert.match(page, /apikey=YOUR-KEY/);
});

test("a rate-limit binding, when bound, says no and the Worker says 429", async () => {
  stubFetch({ "feed.json": { status: 404 } });
  const counted = [];
  const no = { limit: async ({ key }) => { counted.push(key); return { success: false }; } };
  const yes = { limit: async ({ key }) => { counted.push(key); return { success: true }; } };

  const limitedKeys = await callFrom("/api/v1/key", { ...HOSTED, TSP_RATE_KEYS: no }, "203.0.113.9");
  assert.equal(limitedKeys.status, 429);
  assert.equal(limitedKeys.headers.get("retry-after"), "10");
  assert.deepEqual(counted, ["ip:203.0.113.9"], "minting is counted by address");

  const { apikey } = await (await callFrom("/api/v1/key", { ...HOSTED, TSP_RATE_KEYS: yes }, "203.0.113.9")).json();
  counted.length = 0;
  assert.equal((await callFrom(`/api/v1/search?q=x&apikey=${apikey}`, { ...HOSTED, TSP_RATE_SEARCH: no }, "203.0.113.9")).status, 429);
  assert.deepEqual(counted, [`key:${apikey.split(".")[0]}`], "a search is counted against its key first");
  assert.equal((await callFrom("/api/v1/search?q=x&apikey=op", { ...HOSTED, TSP_ADMIN_KEY: "op", TSP_RATE_SEARCH: no }, "203.0.113.9")).status, 200, "the operator is not counted");
  assert.equal((await callFrom(`/api/v1/search?q=x&apikey=${apikey}`, HOSTED, "203.0.113.9")).status, 200, "no binding, no limit");
  const broken = { limit: async () => { throw new Error("no"); } };
  assert.equal((await callFrom(`/api/v1/search?q=x&apikey=${apikey}`, { ...HOSTED, TSP_RATE_SEARCH: broken }, "203.0.113.9")).status, 200, "a limiter that fails limits nothing");
});

test("TSP_ALSO turns a switched-off index on without freezing the list", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const before = await (await call("/api/v1/indexers")).json();
  assert.equal(before.indexers.find((one) => one.id === "bitsearch").enabled, false);
  const after = await (await call("/api/v1/indexers", { TSP_ALSO: "bitsearch" })).json();
  assert.equal(after.indexers.find((one) => one.id === "bitsearch").enabled, true);
  assert.equal(after.indexers.filter((one) => one.enabled).length, before.indexers.filter((one) => one.enabled).length + 1, "and nothing else changed");
});

test("indexes named in TSP_RELAY_INDEXES are asked through the relay, and merge like any other", async () => {
  const hash = "d".repeat(40);
  const rows = [{ name: "Ubuntu Relayed", infohash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, seeders: 9, indexer: "piratebay" }];
  const asked = stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows }) },
    "torrents-csv.com": { body: fixture("torrentscsv.json") },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay,torrentscsv" };
  const body = await (await call("/api/v1/search?q=ubuntu", env)).json();
  const relayed = asked.find((one) => one.url.includes("relay.example"));
  assert.ok(relayed, "the relay was asked");
  assert.equal(relayed.init.headers["x-api-key"], "rk");
  assert.match(decodeURIComponent(relayed.url), /"id":"piratebay"/, "with the descriptor to run");
  assert.match(decodeURIComponent(relayed.url), /q=ubuntu/, "and the query");
  assert.ok(!asked.some((one) => one.url.startsWith("https://apibay.org")), "and the site itself was not");
  assert.deepEqual(body.engines.sort(), ["piratebay", "torrentscsv"]);
  assert.ok(body.torrents.some((torrent) => torrent.name === "Ubuntu Relayed" && torrent.sources.includes("piratebay")));
});

test("a JSON index's names are unescaped, as an HTML page's are", async () => {
  // apibay, 2026-09-26: a name stored for a web page and sent as JSON.
  stubFetch({ "feed.json": { status: 404 }, "new.example": { body: JSON.stringify([
    { n: "Nine Inch Nails &nbsp;The Slip &nbsp;Album -24Bit FLAC", h: "e".repeat(40) },
    { n: "Simon &amp; Garfunkel&#160;&#8211; Bookends", h: "f".repeat(40) },
    { n: "Tom &unknown; Jerry", h: "a".repeat(40) },
  ]) } });
  const descriptor = { id: "new", kind: "json", origins: ["https://new.example"], rows: "", fields: { name: "n", infohash: "h" } };
  const d = encodeURIComponent(JSON.stringify(descriptor));
  const env = { TSP_APIKEY: "rk", TSP_RELAY_ONLY: "1" };
  const whole = await (await call(`/api/v1/relay?d=${d}&q=slip&apikey=rk`, env)).json();
  assert.deepEqual(whole.rows.map((row) => row.name), [
    "Nine Inch Nails The Slip Album -24Bit FLAC",
    "Simon & Garfunkel – Bookends",
    "Tom &unknown; Jerry",
  ], "entities decoded, the space &nbsp; became folded, an unknown entity left as written");
});

test("a relay's names are cleaned on arrival, whatever copy of this file the relay runs", async () => {
  const hash = "d".repeat(40);
  const rows = [{ name: "Nine Inch Nails &nbsp;The Slip &nbsp;Album", infohash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, seeders: 9, indexer: "piratebay" }];
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay" };
  const body = await (await call("/api/v1/search?q=slip", env)).json();
  assert.deepEqual(body.torrents.map((torrent) => torrent.name), ["Nine Inch Nails The Slip Album"]);
});

test("a relay that fails is a failure of that index, not of the search", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "relay.example": { status: 502 }, "torrents-csv.com": { body: fixture("torrentscsv.json") } });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay,torrentscsv" };
  const body = await (await call("/api/v1/search?q=ubuntu", env)).json();
  assert.deepEqual(body.engines, ["torrentscsv"]);
  assert.match(body.failures.piratebay[0], /relay: answered 502/);
});

test("the relay route answers whole, and a relay-only deployment answers nothing else", async () => {
  stubFetch({ "feed.json": { status: 404 }, "new.example": { body: JSON.stringify([{ n: "Thing", h: "c".repeat(40) }]) } });
  const descriptor = { id: "new", kind: "json", origins: ["https://new.example"], rows: "", fields: { name: "n", infohash: "h" } };
  const d = encodeURIComponent(JSON.stringify(descriptor));
  const env = { TSP_APIKEY: "rk", TSP_RELAY_ONLY: "1" };
  const whole = await (await call(`/api/v1/relay?d=${d}&q=thing&apikey=rk`, env)).json();
  assert.equal(whole.origin, "https://new.example");
  assert.equal(whole.rows[0].indexer, "new", "rows as askIndex made them, indexer and all, so a merge elsewhere can use them");
  assert.equal((await call(`/api/v1/relay?d=${d}`, env)).status, 401, "behind its key");
  assert.equal((await call("/api/v1/search?q=x&apikey=rk", env)).status, 404);
  assert.equal((await call("/?apikey=rk", env)).status, 404, "no page: the address is nobody's business");
  assert.equal((await call("/api/v1/key", env)).status, 404);
  assert.equal((await (await call("/api/v1/health", env)).json()).mode, "relay");
});

/** A stand-in for Cloudflare's cache: what was put is what match gives back, as often as asked. */
function stubCache() {
  const held = new Map();
  globalThis.caches = {
    default: {
      match: async (key) => (held.has(key) ? new Response(held.get(key)) : undefined),
      put: async (key, response) => {
        held.set(key, await response.text());
      },
    },
  };
  return held;
}

test("a merged answer is kept for TSP_CACHE seconds and paged from the copy", async () => {
  stubCache();
  try {
    const asked = stubFetch({ "feed.json": { body: catalogueFeed() }, "apibay.org": { body: fixture("piratebay.json") } });
    const sites = () => asked.filter((one) => one.url.includes("apibay.org")).length;
    const env = { TSP_INDEXES: "piratebay" };
    const pending = [];
    const settle = async () => {
      await Promise.all(pending.splice(0));
    };
    const ask = (path, over = {}) => worker.fetch(new Request(`https://w.example${path}`), { ...env, ...over }, { waitUntil: (promise) => pending.push(promise) });

    const first = await ask("/api/v1/search?q=ubuntu&limit=2");
    await settle();
    assert.equal(first.headers.get("x-tsp-cache"), "miss");
    const page1 = await first.json();
    assert.equal(sites(), 1);

    const second = await ask("/api/v1/search?q=ubuntu&limit=2&offset=2");
    assert.equal(second.headers.get("x-tsp-cache"), "hit");
    const page2 = await second.json();
    assert.equal(sites(), 1, "the second page asked nobody");
    assert.equal(page2.count, page1.count);
    assert.notEqual(page2.torrents[0]?.infohash, page1.torrents[0]?.infohash, "and is a different page");
    assert.equal(page2.torrents[0].scraped_at, page1.torrents[0].scraped_at, "rows say when they were really fetched");

    assert.equal((await ask("/api/v1/search?q=ubuntu&limit=2", { TSP_CACHE: "0" })).headers.get("x-tsp-cache"), "miss");
    assert.equal(sites(), 2, "TSP_CACHE=0 asks every time");
    assert.equal((await ask("/api/v1/search?q=ubuntu&cat=video")).headers.get("x-tsp-cache"), "miss", "a different question is a different key");
    await settle();
    assert.equal((await ask("/api/v1/search?q=ubuntu&min_seeders=5")).headers.get("x-tsp-cache"), "hit", "a seeder floor is applied to the copy, not asked again");
  } finally {
    delete globalThis.caches;
  }
});

test("an answer nobody gave is not kept, and a cache that fails is no cache", async () => {
  const held = stubCache();
  try {
    stubFetch({ "feed.json": { body: catalogueFeed() }, "apibay.org": { status: 503 } });
    const pending = [];
    const failed = await worker.fetch(new Request("https://w.example/api/v1/search?q=ubuntu"), { TSP_INDEXES: "piratebay" }, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
    assert.equal(failed.status, 200);
    assert.equal(held.size, 0);

    globalThis.caches.default.match = async () => {
      throw new Error("no cache here");
    };
    assert.equal((await call("/api/v1/search?q=ubuntu", { TSP_INDEXES: "piratebay" })).status, 200);
  } finally {
    delete globalThis.caches;
  }
});

// --- swarm measurement ------------------------------------------------------------

test("the top rows of a search are re-counted by the trackers, and sorted by what they said", async () => {
  const hash = (c) => c.repeat(40);
  const claimed = [
    { name: "Loud Fake", infohash: hash("a"), magnet: `magnet:?xt=urn:btih:${hash("a")}`, seeders: 7513, leechers: 900, indexer: "piratebay" },
    { name: "Quiet Real", infohash: hash("b"), magnet: `magnet:?xt=urn:btih:${hash("b")}`, seeders: 40, leechers: 2, indexer: "piratebay" },
    { name: "Unknown To Trackers", infohash: hash("c"), magnet: `magnet:?xt=urn:btih:${hash("c")}`, seeders: 300, leechers: 1, indexer: "piratebay" },
  ];
  const asked = stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows: claimed }) },
    "relay.example/api/v1/scrape": { body: JSON.stringify({ swarms: { [hash("a")]: { seeders: 0, leechers: 3, answered: 5 }, [hash("b")]: { seeders: 203, leechers: 5, answered: 5 } }, trackers: 5 }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape" };
  const body = await (await call("/api/v1/search?q=thing", env)).json();
  const scrape = asked.find((one) => one.url.includes("/api/v1/scrape"));
  assert.ok(scrape, "the scrape service was asked");
  assert.equal(scrape.init.headers["x-api-key"], "rk");
  assert.match(decodeURIComponent(scrape.url), new RegExp(`${hash("a")},${hash("c")},${hash("b")}`), "about the rows in claimed order");
  assert.deepEqual(body.torrents.map((t) => [t.name, t.seeders, t.measured ?? false]), [
    ["Unknown To Trackers", 300, false],
    ["Quiet Real", 203, true],
    ["Loud Fake", 0, true],
  ], "measured counts replace claims, the list is re-sorted, and a row no tracker knew keeps its claim");
  assert.equal(body.failures, undefined);
});

test("rows with no count at all are measured too, past the top", async () => {
  // A site that publishes no counts sorts every row to the very end, so the
  // top was never where they were and nothing ever gave them a number.
  const hash = (i) => i.toString(16).padStart(40, "0");
  const claimed = Array.from({ length: 3 }, (_, i) => ({ name: `Claimed ${i}`, infohash: hash(i + 1), magnet: `magnet:?xt=urn:btih:${hash(i + 1)}`, seeders: 100 - i, indexer: "piratebay" }));
  const fresh = { name: "I'm Game (2026) Malayalam", infohash: hash(99), magnet: `magnet:?xt=urn:btih:${hash(99)}`, indexer: "piratebay" };
  const asked = stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows: [...claimed, fresh] }) },
    "relay.example/api/v1/scrape": { body: JSON.stringify({ swarms: { [hash(99)]: { seeders: 125, leechers: 9, answered: 5 } }, trackers: 5 }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape", TSP_SCRAPE_TOP: "2" };
  const body = await (await call("/api/v1/search?q=thing", env)).json();
  const scraped = asked.filter((one) => one.url.includes("/api/v1/scrape")).map((one) => decodeURIComponent(one.url)).join(" ");
  assert.ok(scraped.includes(hash(99)), "the uncounted row was asked about although it sat below the top two");
  assert.ok(!scraped.includes(hash(3)), "a counted row below the top is still left alone");
  assert.equal(body.torrents[0].name, "I'm Game (2026) Malayalam", "and, measured, it sorts where its swarm puts it");
  assert.equal(body.torrents[0].seeders, 125);
});

test("a scrape service that fails leaves the claims alone and says so", async () => {
  const hash = "d".repeat(40);
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows: [{ name: "Thing", infohash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, seeders: 9, indexer: "piratebay" }] }) },
    "relay.example/api/v1/scrape": { status: 502 },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape" };
  const body = await (await call("/api/v1/search?q=thing", env)).json();
  assert.equal(body.torrents[0].seeders, 9);
  assert.equal(body.torrents[0].measured, undefined);
  assert.deepEqual(body.failures, { scrape: ["scrape answered 502"] });
});

test("a relay hands /api/v1/scrape to the service next door, hashes checked, behind its key", async () => {
  const asked = stubFetch({ "feed.json": { status: 404 }, "127.0.0.1:8788/scrape": { body: JSON.stringify({ swarms: { ["e".repeat(40)]: { seeders: 1, leechers: 0, answered: 3 } }, trackers: 5 }) } });
  const env = { TSP_APIKEY: "rk", TSP_RELAY_ONLY: "1", TSP_SCRAPE_LOCAL: "http://127.0.0.1:8788/scrape" };
  assert.equal((await call(`/api/v1/scrape?h=${"e".repeat(40)}`, env)).status, 401, "behind the key");
  const good = await (await call(`/api/v1/scrape?h=${"E".repeat(40)},nonsense,${"e".repeat(40)}&apikey=rk`, env)).json();
  assert.equal(good.swarms["e".repeat(40)].seeders, 1);
  assert.match(asked.find((one) => one.url.includes("8788")).url, new RegExp(`h=${"e".repeat(40)}$`), "lower-cased, de-duplicated, nonsense dropped");
  assert.equal((await call("/api/v1/scrape?h=zz&apikey=rk", env)).status, 400);
  assert.equal((await call(`/api/v1/scrape?h=${"e".repeat(40)}&apikey=rk`, { TSP_APIKEY: "rk" })).status, 404, "no service configured, no route");
});

test("the operator's search is always fresh, and refreshes the copy everyone else gets", async () => {
  stubCache();
  try {
    const asked = stubFetch({ "feed.json": { body: catalogueFeed() }, "apibay.org": { body: fixture("piratebay.json") } });
    const sites = () => asked.filter((one) => one.url.startsWith("https://apibay.org")).length;
    const env = { TSP_KEY_SECRET: "s3cret", TSP_ADMIN_KEY: "op", TSP_INDEXES: "piratebay" };
    const pending = [];
    const ask = (path) => worker.fetch(new Request(`https://w.example${path}`), env, { waitUntil: (promise) => pending.push(promise) });
    const { apikey } = await (await ask("/api/v1/key")).json();

    assert.equal((await ask(`/api/v1/search?q=ubuntu&apikey=${apikey}`)).headers.get("x-tsp-cache"), "miss");
    await Promise.all(pending.splice(0));
    assert.equal((await ask(`/api/v1/search?q=ubuntu&apikey=${apikey}`)).headers.get("x-tsp-cache"), "hit");
    assert.equal(sites(), 1);

    assert.equal((await ask("/api/v1/search?q=ubuntu&apikey=op")).headers.get("x-tsp-cache"), "miss", "the operator is never served the copy");
    await Promise.all(pending.splice(0));
    assert.equal(sites(), 2, "and asks the indexes again");
    assert.equal((await ask(`/api/v1/search?q=ubuntu&apikey=${apikey}`)).headers.get("x-tsp-cache"), "hit", "which is what everyone else now gets");
  } finally {
    delete globalThis.caches;
  }
});

test("more than fifty rows to measure go out as batches, together", async () => {
  const rows = Array.from({ length: 120 }, (_, i) => {
    const hash = i.toString(16).padStart(40, "0");
    return { name: `Row ${i}`, infohash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, seeders: 1000 - i, indexer: "piratebay" };
  });
  const asked = stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows }) },
    "relay.example/api/v1/scrape": { body: JSON.stringify({ swarms: { [rows[0].infohash]: { seeders: 0, leechers: 0, answered: 3 }, [rows[99].infohash]: { seeders: 5000, leechers: 1, answered: 3 } } }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape" };
  const body = await (await call("/api/v1/search?q=row&limit=3", env)).json();
  const scrapes = asked.filter((one) => one.url.includes("/api/v1/scrape"));
  assert.equal(scrapes.length, 2, "a hundred hashes, two requests");
  assert.equal(scrapes.map((one) => decodeURIComponent(one.url).split("h=")[1].split(",").length).join("+"), "50+50");
  assert.equal(body.torrents[0].name, "Row 99", "the hundredth row, measured at 5000, leads");
  assert.equal(body.torrents[0].measured, true);
  assert.equal(body.torrents.at(-1).name, "Row 2", "and the top three are settled by claim after that");
});

// --- a metered index -----------------------------------------------------------

const { resetQuotas } = __testing;

test("an index that says it is nearly out of requests is left alone until the reset it named", async () => {
  resetQuotas();
  const reset = new Date(Date.now() + 3600_000).toISOString();
  let calls = 0;
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.includes("feed.json")) return new Response(catalogueFeed());
    if (address.includes("bitsearch.eu")) {
      calls += 1;
      return new Response(JSON.stringify({ results: [{ title: "Thing", infohash: "a".repeat(40), size: 1, seeders: 5, leechers: 1 }] }), {
        headers: { "x-ratelimit-limit": "200", "x-ratelimit-remaining": calls === 1 ? "7" : "6", "x-ratelimit-reset": reset },
      });
    }
    return new Response("no", { status: 404 });
  };
  const env = { TSP_INDEXES: "bitsearch" };
  const first = await (await call("/api/v1/search?q=thing", env)).json();
  assert.equal(first.count, 1, "the answer that carried the warning is still used");
  assert.equal(first.failures, undefined, "an index that answered is not a failure");
  const second = await (await call("/api/v1/search?q=other", env)).json();
  assert.equal(calls, 1, "the next search does not ask");
  assert.deepEqual(second.engines, []);
  assert.match(second.failures.bitsearch[0], /quota: 7 of 200/);
  resetQuotas();
  await call("/api/v1/search?q=again", env);
  assert.equal(calls, 2, "after the reset it is asked again");
  resetQuotas();
});

test("a refusal that names the quota is reported as the quota, not as a status", async () => {
  resetQuotas();
  stubFetch({ "feed.json": { body: catalogueFeed() } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("bitsearch.eu")) return new Response("", { status: 429, headers: { "x-ratelimit-limit": "200", "x-ratelimit-remaining": "0" } });
    return real(url, init);
  };
  const body = await (await call("/api/v1/search?q=thing", { TSP_INDEXES: "bitsearch" })).json();
  assert.match(body.failures.bitsearch[0], /^quota: 0 of 200 requests left; not asked again before then$/);
  resetQuotas();
});

test("TSP_INDEX_HEADERS sends one index a header the catalogue must not carry", async () => {
  resetQuotas();
  const asked = stubFetch({ "feed.json": { body: catalogueFeed() }, "bitsearch.eu": { body: JSON.stringify({ results: [] }) }, "apibay.org": { body: fixture("piratebay.json") } });
  await call("/api/v1/search?q=thing", { TSP_INDEXES: "bitsearch,piratebay", TSP_INDEX_HEADERS: JSON.stringify({ bitsearch: { "x-api-key": "k-1" } }) });
  const bits = asked.find((one) => one.url.includes("bitsearch.eu"));
  const bay = asked.find((one) => one.url.includes("apibay.org"));
  assert.equal(bits.init.headers["x-api-key"], "k-1");
  assert.equal(bay.init.headers["x-api-key"], undefined, "and nobody else");
  await call("/api/v1/search?q=thing", { TSP_INDEXES: "bitsearch", TSP_INDEX_HEADERS: "not json" });
  assert.equal(asked.filter((one) => one.url.includes("bitsearch.eu")).length, 2, "a setting that does not parse is an empty one");
});

test("an index with cache_s is asked once per query per that long, and a failure is not kept", async () => {
  resetQuotas();
  stubCache();
  try {
    const feed = JSON.parse(catalogueFeed());
    feed.indexes = feed.indexes.map((one) => (one.id === "piratebay" ? { ...one, cache_s: 3600 } : one));
    let status = 200;
    const asked = stubFetch({ "feed.json": { body: JSON.stringify(feed) } });
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).startsWith("https://apibay.org") ? (asked.push({ url: String(url), init }), new Response(status === 200 ? fixture("piratebay.json") : "", { status })) : real(url, init));
    const bay = () => asked.filter((one) => one.url.startsWith("https://apibay.org")).length;
    const env = { TSP_INDEXES: "piratebay", TSP_CACHE: "0" };

    status = 503;
    assert.equal((await (await call("/api/v1/search?q=ubuntu", env)).json()).engines.length, 0);
    assert.equal(bay(), 1);
    status = 200;
    assert.ok((await (await call("/api/v1/search?q=ubuntu", env)).json()).count > 0, "a failure was not kept, so it is asked again");
    assert.equal(bay(), 2);
    assert.ok((await (await call("/api/v1/search?q=ubuntu", env)).json()).count > 0);
    assert.equal(bay(), 2, "and an answer is kept: the third search asked nobody");
    await call("/api/v1/search?q=debian", env);
    assert.equal(bay(), 3, "another query is another question");
  } finally {
    delete globalThis.caches;
  }
});

// --- planted swarms -------------------------------------------------------------

const { inflated, judgeSwarm, doubtClaims } = __testing;

test("a tracker report wears the bot's shape, or does not", () => {
  // the loudest Photoshop on opentrackr, 2026-09-17: two leechers to three seeders, 72 completions
  assert.equal(inflated({ seeders: 94838, leechers: 63073, completed: 72 }), true);
  // the same bot on a tracker that never counts completions
  assert.equal(inflated({ seeders: 39413, leechers: 26276, completed: null }), true);
  // a real Photoshop crack: 1895 seeders, 42 leechers, 40 completions on the tracker's counter
  assert.equal(inflated({ seeders: 1895, leechers: 42, completed: 40 }), false);
  // Special Ops Lioness S03E03: exactly 1.50 on one tracker, and 10,382 completions to answer for it
  assert.equal(inflated({ seeders: 114, leechers: 76, completed: 10382 }), false);
  // a fresh episode at 1.488 the day after it aired, kept by its completions
  assert.equal(inflated({ seeders: 2225, leechers: 1495, completed: 23561 }), false);
  // the same numbers with no completions known are the bot's shape and nothing to answer for it
  assert.equal(inflated({ seeders: 2225, leechers: 1495 }), true);
  // a small planted copy that drifted off the ratio, but zero completions at 299 seeders
  assert.equal(inflated({ seeders: 299, leechers: 203, completed: 0 }), true);
  // under two hundred seeders the completions say nothing, and 1.41 is not the shape
  assert.equal(inflated({ seeders: 116, leechers: 82, completed: 0 }), false);
  // a swarm of five is never judged on its ratio
  assert.equal(inflated({ seeders: 3, leechers: 2 }), false);
  assert.equal(inflated({ seeders: 0, leechers: 0, completed: 0 }), false);
  assert.equal(inflated({}), false);
});

test("a swarm is the largest count the honest trackers gave, and suspect when the planted number was the story", () => {
  const otr = (seeders, leechers, completed) => ({ tracker: "tracker.opentrackr.org", seeders, leechers, completed });
  const stl = (seeders, leechers, completed) => ({ tracker: "open.stealth.si", seeders, leechers, completed });
  const dmn = (seeders, leechers) => ({ tracker: "open.demonii.com", seeders, leechers, completed: null });
  const exo = (seeders, leechers, completed) => ({ tracker: "exodus.desync.com", seeders, leechers, completed });

  // Adobe Photoshop for Mac 2024, as four trackers reported it
  assert.deepEqual(judgeSwarm([otr(94838, 63073, 72), stl(14, 0, 67), dmn(10, 1), exo(4, 2, 10)]), { seeders: 14, leechers: 2, answered: 4, suspect: true, claimed: 94838 });
  // Premiere Pro v25.4.1, planted on every tracker that answered
  assert.deepEqual(judgeSwarm([otr(83461, 55618, 3), stl(51203, 34135, 0), exo(29125, 19417, 1)]), { seeders: 0, leechers: 0, answered: 3, suspect: true, claimed: 83461 });
  // Photoshop 2023 by TheWindowsForum, a real swarm the trackers roughly agree on
  assert.deepEqual(judgeSwarm([otr(1895, 42, 40), stl(1869, 33, 25), dmn(206, 3), exo(649, 17, 16)]), { seeders: 1895, leechers: 42, answered: 4, suspect: false, claimed: 0 });
  // Oppenheimer, with demonii at 1.50 by coincidence and no completions to show: that report is set aside, the swarm stands
  assert.deepEqual(judgeSwarm([otr(946, 209, 36), stl(1042, 184, 95), dmn(210, 140), exo(313, 35, 12)]), { seeders: 1042, leechers: 209, answered: 4, suspect: false, claimed: 210 });
  // a swarm nobody knows is measured, at zero, and not suspect
  assert.deepEqual(judgeSwarm([otr(0, 0, 0), stl(0, 0, 0)]), { seeders: 0, leechers: 0, answered: 2, suspect: false, claimed: 0 });
  assert.deepEqual(judgeSwarm([]), { seeders: 0, leechers: 0, answered: 0, suspect: false, claimed: 0 });
});

test("a claim the trackers never checked is judged by its shape, and set aside rather than dropped", () => {
  const rows = [
    { name: "Wave of 2021", seeders: 2331, leechers: 1555, completed: 5 },
    { name: "Same shape, no count", seeders: 900, leechers: 600 },
    { name: "Same shape, answered for", seeders: 2331, leechers: 1555, completed: 109277 },
    { name: "Real", seeders: 1913, leechers: 48, completed: 109277 },
    { name: "Already measured", seeders: 300, leechers: 200, measured: true },
    { name: "Unknown", size_bytes: 5 },
  ];
  const judged = doubtClaims(rows);
  assert.deepEqual(
    judged.map((row) => [row.name, row.seeders, row.suspect ?? false, row.claimed_seeders]),
    [
      ["Same shape, answered for", 2331, false, undefined],
      ["Real", 1913, false, undefined],
      ["Already measured", 300, false, undefined],
      ["Wave of 2021", 0, true, 2331],
      ["Same shape, no count", 0, true, 900],
      ["Unknown", undefined, false, undefined],
    ],
    "the planted claims go to the bottom at zero with their claim beside them; a measured row is not judged twice; a row with no count still comes last",
  );
});

test("the trackers' own reports are judged one by one, and a planted swarm comes out suspect, at what the honest trackers saw", async () => {
  const hash = (c) => c.repeat(40);
  const claimed = [
    { name: "Photoshop 2026 (New) (Verified)", infohash: hash("a"), magnet: `magnet:?xt=urn:btih:${hash("a")}`, seeders: 64821, leechers: 43182, completed: 5, indexer: "piratebay" },
    { name: "Photoshop 2023 [TheWindowsForum]", infohash: hash("b"), magnet: `magnet:?xt=urn:btih:${hash("b")}`, seeders: 1423, leechers: 34, completed: 109277, indexer: "piratebay" },
    { name: "Nobody knows", infohash: hash("c"), magnet: `magnet:?xt=urn:btih:${hash("c")}`, seeders: 3, leechers: 1, indexer: "piratebay" },
  ];
  const report = (tracker, seeders, leechers, completed) => ({ tracker, seeders, leechers, completed });
  const swarms = {
    [hash("a")]: {
      reports: [report("tracker.opentrackr.org", 94838, 63073, 72), report("open.stealth.si", 14, 0, 67), report("open.demonii.com", 10, 1, null)],
      seeders: 94838,
      leechers: 63073,
      answered: 3,
    },
    [hash("b")]: { reports: [report("tracker.opentrackr.org", 1895, 42, 40), report("open.demonii.com", 206, 3, null)], seeders: 1895, leechers: 42, answered: 2 },
  };
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows: claimed }) },
    "relay.example/api/v1/scrape": { body: JSON.stringify({ swarms, trackers: 5 }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape" };
  const body = await (await call("/api/v1/search?q=photoshop", env)).json();
  assert.deepEqual(
    body.torrents.map((t) => [t.name, t.seeders, t.leechers, t.measured ?? false, t.suspect ?? false, t.claimed_seeders, t.completed]),
    [
      ["Photoshop 2023 [TheWindowsForum]", 1895, 42, true, false, undefined, 109277],
      ["Photoshop 2026 (New) (Verified)", 14, 1, true, true, 94838, 5],
      ["Nobody knows", 3, 1, false, false, undefined, undefined],
    ],
    "the planted swarm falls to what the honest trackers saw, says so, and keeps the largest number it advertised",
  );
  const dropped = await (await call("/api/v1/search?q=photoshop&suspect=drop", env)).json();
  assert.deepEqual(dropped.torrents.map((t) => t.name), ["Photoshop 2023 [TheWindowsForum]", "Nobody knows"], "suspect=drop leaves the planted row out");
  assert.equal(dropped.count, 2);
});

test("the completed count of an index that keeps one comes through, and is judged", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed() }, "api.knaben.org": { body: fixture("knaben.json") }, "torrents-csv.com": { body: fixture("torrentscsv.json") } });
  const body = await (await call("/api/v1/search?q=big+buck+bunny&indexers=knaben,torrentscsv")).json();
  const bunny = body.torrents.find((t) => t.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.ok(bunny, "the shared row is there");
  assert.equal(bunny.completed, 9120, "knaben's grabs, from the row with more seeders");
  assert.equal(bunny.suspect, undefined);
});

test("a scrape service that still answers one count per swarm has that count judged as one report", async () => {
  const hash = (c) => c.repeat(40);
  const claimed = [
    { name: "Planted, index counted five downloads", infohash: hash("a"), magnet: `magnet:?xt=urn:btih:${hash("a")}`, seeders: 64821, leechers: 43182, completed: 5, indexer: "piratebay" },
    { name: "Real", infohash: hash("b"), magnet: `magnet:?xt=urn:btih:${hash("b")}`, seeders: 1423, leechers: 34, completed: 109277, indexer: "piratebay" },
  ];
  stubFetch({
    "feed.json": { body: catalogueFeed() },
    "relay.example/api/v1/relay": { body: JSON.stringify({ id: "piratebay", origin: "https://apibay.org", problems: [], rows: claimed }) },
    "relay.example/api/v1/scrape": { body: JSON.stringify({ swarms: { [hash("a")]: { seeders: 94838, leechers: 63073, answered: 5 }, [hash("b")]: { seeders: 1895, leechers: 42, answered: 5 } }, trackers: 5 }) },
  });
  const env = { TSP_RELAY_URL: "https://relay.example", TSP_RELAY_KEY: "rk", TSP_RELAY_INDEXES: "piratebay", TSP_INDEXES: "piratebay", TSP_SCRAPE_URL: "https://relay.example/api/v1/scrape" };
  const body = await (await call("/api/v1/search?q=thing", env)).json();
  assert.deepEqual(
    body.torrents.map((t) => [t.name, t.seeders, t.measured ?? false, t.suspect ?? false, t.claimed_seeders]),
    [
      ["Real", 1895, true, false, undefined],
      ["Planted, index counted five downloads", 0, true, true, 94838],
    ],
  );
});

// --- following a page ------------------------------------------------------------

const { readPage, resetPages } = __testing;
afterEach(() => resetPages());

const FORUM = {
  id: "forum",
  kind: "html",
  match: "name",
  origins: ["https://forum.example"],
  request: { method: "GET", path: "/index.php?/forums/forum/35-predvd/" },
  rows: "li.ipsDataItem[data-rowid]",
  fields: {
    name: { sel: "h4.ipsDataItem_title a" },
    page: { sel: "h4.ipsDataItem_title a", attr: "href" },
    first_seen: { sel: "div.ipsDataItem_meta time", attr: "datetime" },
    category: { const: "video" },
  },
  follow: { rows: "a[href^='magnet:']", fields: { magnet: { attr: "href" } }, most: 4 },
  cache_s: 900,
};

test("a descriptor may follow a page for its magnets, and says so completely or not at all", () => {
  assert.equal(descriptorProblem(FORUM), "");
  assert.match(descriptorProblem({ ...FORUM, follow: { fields: { magnet: { attr: "href" } } } }), /follow.rows/);
  assert.match(descriptorProblem({ ...FORUM, follow: { rows: "a", fields: { name: "x" } } }), /infohash or a magnet/);
  assert.match(descriptorProblem({ ...FORUM, follow: { rows: "a", fields: { magnet: { attr: "href" }, page: { attr: "href" } } } }), /unknown follow field page/);
  assert.match(descriptorProblem({ ...FORUM, follow: { ...FORUM.follow, most: 0 } }), /follow.most/);
  assert.match(descriptorProblem({ ...FORUM, fields: { name: FORUM.fields.name } }), /must yield page/);
  assert.match(descriptorProblem({ ...FORUM, follow: undefined, fields: { name: "x", infohash: { attr: "data-hash" } } }), /^$/, "an attribute of the row itself needs no selector");
});

test("a row that yields only a magnet link is named and sized by it", () => {
  const hash = "6e7781b62a666908029b2a66a019350541a65549";
  const [row] = rowsFrom("html", `<p><a href="magnet:?xt=urn:btih:${hash}&amp;dn=A%20Film%20%282026%29%20-%201080p&amp;xl=3126399022&amp;tr=udp%3A%2F%2Ft.example"></a></p>`, "a");
  const read = readRow({ id: "x", kind: "html", fields: { magnet: { attr: "href" } } }, row, "https://forum.example", 0);
  assert.equal(read.name, "A Film (2026) - 1080p");
  assert.equal(read.size_bytes, 3126399022);
  assert.equal(read.infohash, hash);
});

test("the listing's rows that match the query are followed to their pages, and come back as that page's magnets", async () => {
  const listing = fixture("1tamilmv.html");
  const topic = fixture("1tamilmv-topic.html");
  const asked = stubFetch({ "feed.json": { body: catalogueFeed({ indexes: [FORUM] }) }, "forums/forum/35-predvd": { body: listing }, "forums/topic/": { body: topic } });
  const env = { TSP_INDEXES: "forum" };

  const body = await (await call("/api/v1/search?q=bethlehem+kudumba+unit", env)).json();
  assert.equal(body.count, 2, "two magnets on the topic page");
  const [one, two] = body.torrents.sort((a, b) => b.size_bytes - a.size_bytes);
  assert.match(one.name, /^www\.1TamilMV\.meme - Bethlehem Kudumba Unit \(2026\) Malayalam HQ PreDVD - 1080p/, "named by the magnet");
  assert.equal(one.size_bytes, 3126399022, "sized by the magnet");
  assert.equal(one.infohash, "6e7781b62a666908029b2a66a019350541a65549");
  assert.equal(one.category, "video", "inherited from the listing row");
  assert.equal(one.first_seen, "2026-09-07T05:10:23.000Z", "the topic's date, from the listing row");
  assert.match(one.description_url, /forums\/topic\/199657-bethlehem-kudumba-unit/, "the page it came from");
  assert.equal(two.size_bytes, 1576992293);
  assert.equal(asked.filter((a) => a.url.includes("forums/topic/")).length, 1, "one page followed: the one lead that matched");
  assert.equal(body.failures, undefined);

  const none = await (await call("/api/v1/search?q=nothing+here", env)).json();
  assert.equal(none.count, 0);
  assert.equal(asked.filter((a) => a.url.includes("forums/forum/35-predvd")).length, 1, "the listing is the same page for every query, fetched once per cache_s");
  assert.equal(asked.filter((a) => a.url.includes("forums/topic/")).length, 1, "and nothing was followed for a query nothing matched");

  const capped = await (await call("/api/v1/search?q=2026&indexers=forum", { ...env, TSP_FEED_URL: "https://feed.example/feed.json" })).json();
  assert.ok(capped.count >= 2, "every 2026 topic matched and was followed");
});

test("a followed page that fails is a note against the index, not a failed search", async () => {
  stubFetch({ "feed.json": { body: catalogueFeed({ indexes: [{ ...FORUM, origins: ["https://forum2.example"] }] }) }, "forums/forum/35-predvd": { body: fixture("1tamilmv.html").replaceAll("www.1tamilmv.rocks", "forum2.example") }, "forums/topic/": { status: 503 } });
  const body = await (await call("/api/v1/search?q=bethlehem+kudumba+unit", { TSP_INDEXES: "forum" })).json();
  assert.equal(body.count, 0);
  assert.deepEqual(body.engines, ["forum"], "the listing answered");
  assert.equal(body.failures, undefined, "a page that fails is not the index failing");
});

test("readPage reads a recorded page through a lead, as the build's replay does", () => {
  const lead = { indexer: "forum", name: "Some Film (2026) Malayalam HQ PreDVD", page: "https://forum.example/index.php?/forums/topic/1-some-film/", first_seen: "2026-09-07T05:10:23.000Z", category: "video" };
  const rows = readPage(FORUM, lead, fixture("1tamilmv-topic.html"), "https://forum.example", 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].description_url, lead.page);
  assert.equal(rows[0].first_seen, lead.first_seen);
  assert.equal(rows[0].page, undefined, "a page is where a lead points, not a field of a result");
});
