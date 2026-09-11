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
