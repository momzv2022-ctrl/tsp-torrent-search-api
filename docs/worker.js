/**
 * tsp-torrent-search-api, a TSP search API over public torrent indexes,
 * in one file, run for free by Cloudflare.
 *
 * Paste this into a Worker and it answers `GET /api/v1/search?q=…` with the
 * Torrent Search Protocol's JSON, the same shape the Unified Torrent Search
 * Interface speaks, so anything that already talks to UTSI talks to this.
 * Its `/` page shows you the URL and the key.
 *
 * The thing worth explaining is where the list of sites comes from, because
 * that is the whole design.
 *
 *   catalogue/*.json  in the repository, one descriptor per site, data
 *          ↓           `npm run build`
 *   docs/feed.json    published on GitHub Pages
 *          ↓           fetched by every deployment, hourly
 *   this Worker       which holds no opinion of its own about what to search
 *
 * The copy compiled in below is a cold-start fallback, not the source of
 * truth: a Worker that has been up for an hour is searching whatever the feed
 * says, not whatever was true the day it was pasted. That is deliberate. The
 * project this one replaces generated its feed *from* a list inside the
 * Worker, which meant the catalogue could only ever be what someone had typed
 * into a source file, and a deployed Worker was a photograph. Here the arrow
 * runs the other way, and the catalogue itself is kept honest by
 * `npm run sync`, which reads prajwalch/TorrentSearch, a project whose whole
 * business is keeping up with these sites, and reports what it has that we
 * do not.
 *
 * So: to add a site, add a JSON file and push. Nobody re-pastes anything.
 *
 * Sections:
 *   1. settings:        env, and the key
 *   2. the feed:        fetch, cache, trust
 *   3. descriptors:     the little language the catalogue is written in
 *   4. reading answers: JSON, RSS and HTML into rows
 *   5. the pipeline:    ask every index, merge, sort, page
 *   6. routes:          /api/v1/search, /indexers, /try, /health, and /
 */

// --- 1. settings -------------------------------------------------------------

/** Where the catalogue lives. `TSP_FEED_URL` moves it; `TSP_FEED=0` pins the compiled copy. */
const DEFAULT_FEED_URL = "https://momzv2022-ctrl.github.io/tsp-torrent-search-api/feed.json";

/**
 * The key, written in by the setup page.
 *
 * The line below must ship empty. `npm run build` refuses to publish a source
 * in which it is not, because a key committed by accident is a key handed to
 * everyone who ever used the page.
 */
const BAKED_APIKEY = "";

/** The catalogue as it stood when this file was built. A fallback, not a source of truth. */
const BAKED_CATALOGUE = [{"id":"animetosho","upstream":"animetosho","name":"AnimeTosho","site":"https://animetosho.org","kind":"json","enabled":true,"origins":["https://feed.animetosho.org"],"categories":["anime"],"request":{"method":"GET","path":"/json","query":{"q":"{q}"}},"fields":{"name":"title","infohash":"magnet_uri","size_bytes":"total_size","seeders":"seeders","leechers":"leechers","first_seen":"timestamp","description_url":"link"}},{"id":"bitsearch","upstream":"bitsearch","name":"BitSearch","site":"https://bitsearch.to","kind":"json","enabled":false,"origins":["https://bitsearch.eu","https://bitsearch.to"],"categories":["anime","apps","books","games","movies","music","porn","series","other"],"request":{"method":"GET","path":"/api/v1/search","query":{"q":"{q}","category":"all","sort":"seeders"}},"rows":"results","fields":{"name":"title","infohash":"infohash","size_bytes":"size","seeders":"seeders","leechers":"leechers","first_seen":"createdAt","description_url":{"template":"https://bitsearch.eu/torrent/{value}","from":"id"}}},{"id":"dmhy","upstream":"dmhy","name":"Dmhy","site":"https://share.dmhy.org","kind":"rss","enabled":true,"origins":["https://share.dmhy.org"],"categories":["anime","books","games","music","series","other"],"request":{"method":"GET","path":"/topics/rss/rss.xml","query":{"keyword":"{q}"}},"fields":{"name":"title","infohash":"enclosure@url","first_seen":"pubDate","description_url":"link"}},{"id":"eztvx","upstream":"eztvx","name":"Eztv","site":"https://eztvx.to","kind":"json","enabled":true,"match":"name","origins":["https://eztvx.to"],"categories":["series"],"cloudflare":true,"request":{"method":"GET","path":"/api/get-torrents","query":{"limit":"{limit}","page":"1","Keywords":"{q}"}},"rows":"torrents","fields":{"name":"title","infohash":["hash","magnet_url"],"size_bytes":{"from":"size_bytes","nonzero":true},"seeders":"seeds","leechers":"peers","category":{"const":"video"},"first_seen":"date_released_unix","description_url":"episode_url"}},{"id":"knaben","upstream":"knaben","name":"Knaben","site":"https://knaben.org","kind":"json","enabled":true,"origins":["https://api.knaben.org","https://api.knaben.eu"],"categories":["anime","apps","books","games","movies","music","other","porn","series"],"request":{"method":"POST","path":"/v1","body":{"search_type":"100%","search_field":"title","query":"{q}","order_by":"seeders","order_direction":"desc","from":0,"size":"{limit}","hide_unsafe":true}},"rows":"hits","fields":{"name":"title","infohash":["hash","magnetUrl"],"size_bytes":"bytes","seeders":"seeders","leechers":"peers","first_seen":"date","description_url":"details","category":{"from":"categoryId","re":"^(\\d+)","map":{"1000000":"audio","2000000":"video","3000000":"video","4000000":"software","5000000":"video","6000000":"video","7000000":"software","9000000":"document"}}}},{"id":"nyaa","upstream":"nyaasi","name":"Nyaa","site":"https://nyaa.si","kind":"rss","enabled":false,"origins":["https://nyaa.si"],"categories":["anime","apps","books","games","music","series"],"request":{"method":"GET","path":"/","query":{"page":"rss","q":"{q}"}},"fields":{"name":"title","infohash":"nyaa:infoHash","size_bytes":"nyaa:size","seeders":"nyaa:seeders","leechers":"nyaa:leechers","category":{"from":"nyaa:categoryId","prefix":1,"map":{"1":"video","2":"audio","3":"document","4":"video","5":"image","6":"software"}},"first_seen":"pubDate","torrent_url":"link","description_url":"guid"}},{"id":"piratebay","upstream":"thepiratebay","name":"ThePirateBay","site":"https://thepiratebay.org","kind":"json","enabled":true,"origins":["https://apibay.org"],"categories":["apps","books","games","movies","music","porn","series","other"],"request":{"method":"GET","path":"/q.php","query":{"q":"{q}"}},"fields":{"name":"name","infohash":"info_hash","size_bytes":{"from":"size","nonzero":true},"files":{"from":"num_files","nonzero":true},"seeders":"seeders","leechers":"leechers","category":{"from":"category","prefix":1,"map":{"1":"audio","2":"video","3":"software","4":"software"}},"first_seen":"added","description_url":{"template":"https://thepiratebay.org/description.php?id={value}","from":"id"}}},{"id":"rutor","upstream":"rutorinfo","name":"Rutor","site":"https://rutor.info","kind":"html","enabled":true,"origins":["https://rutor.info","https://rutor.is"],"categories":["anime","apps","books","games","movies","music","other","series"],"request":{"method":"GET","path":"/search/0/0/100/0/{q}"},"rows":"div#index tr.gai, div#index tr.tum","fields":{"name":{"sel":"a[href^='/torrent/']"},"infohash":{"sel":"a[href^='magnet:']","attr":"href"},"size_bytes":{"cell":-2},"seeders":{"sel":"span.green"},"leechers":{"sel":"span.red"},"torrent_url":{"sel":"a.downgif","attr":"href"},"description_url":{"sel":"a[href^='/torrent/']","attr":"href"}}},{"id":"sukebei","upstream":"sukebeinyaa","name":"Sukebei","site":"https://sukebei.nyaa.si","kind":"rss","enabled":true,"origins":["https://sukebei.nyaa.si"],"categories":["porn"],"nsfw":true,"request":{"method":"GET","path":"/","query":{"page":"rss","q":"{q}"}},"fields":{"name":"title","infohash":"nyaa:infoHash","size_bytes":"nyaa:size","seeders":"nyaa:seeders","leechers":"nyaa:leechers","first_seen":"pubDate","torrent_url":"link","description_url":"guid"}},{"id":"torrentdownload","upstream":"torrentdownloadinfo","name":"TorrentDownload","site":"https://www.torrentdownload.info","kind":"html","enabled":false,"origins":["https://www.torrentdownload.info"],"categories":["anime","apps","books","games","movies","music","porn","series","other"],"request":{"method":"GET","path":"/search","query":{"q":"{q}"}},"rows":"table.table2 tr","fields":{"name":{"sel":"td.tdleft a"},"infohash":{"sel":"td.tdleft a","attr":"href"},"size_bytes":{"cell":3},"seeders":{"sel":"td.tdseed"},"leechers":{"sel":"td.tdleech"},"description_url":{"sel":"td.tdleft a","attr":"href"}}},{"id":"torrentdownloads","upstream":"torrentdownloads","name":"TorrentDownloads","site":"https://www.torrentdownloads.pro","kind":"rss","enabled":true,"match":"name","origins":["https://www.torrentdownloads.pro"],"categories":["anime","apps","books","games","movies","music","series","other"],"cloudflare":true,"request":{"method":"GET","path":"/rss.xml","query":{"type":"search","search":"{q}"}},"fields":{"name":"title","infohash":"info_hash","size_bytes":"size","seeders":"seeders","leechers":"leechers","first_seen":"pubDate","description_url":{"from":"link"}}},{"id":"torrentkitty","upstream":"torrentkitty","name":"TorrentKitty","site":"https://www.torrentkitty.tv","kind":"html","enabled":false,"origins":["https://www.torrentkitty.tv"],"categories":["other"],"request":{"method":"GET","path":"/search/{q}/"},"rows":"table#archiveResult tr","fields":{"name":{"sel":"td.name"},"infohash":{"sel":"td.action a[href^='magnet:']","attr":"href"},"size_bytes":{"sel":"td.size"},"first_seen":{"sel":"td.date"},"description_url":{"sel":"td.action a[href^='/information/']","attr":"href"}}},{"id":"torrentscsv","upstream":"torrentscsv","name":"TorrentsCSV","site":"https://torrents-csv.com","kind":"json","enabled":true,"origins":["https://torrents-csv.com"],"categories":["other"],"request":{"method":"GET","path":"/service/search","query":{"q":"{q}","size":"{limit}"}},"rows":"torrents","fields":{"name":"name","infohash":"infohash","size_bytes":"size_bytes","seeders":"seeders","leechers":"leechers","first_seen":"created_unix"}},{"id":"yts","upstream":"ytsmx","name":"Yts","site":"https://yts.gg","kind":"json","enabled":true,"origins":["https://yts.gg","https://movies-api.accel.li","https://yts.bz","https://yts.lt"],"categories":["movies"],"request":{"method":"GET","path":"/api/v2/list_movies.json","query":{"query_term":"{q}","limit":"{limit}"}},"rows":"data.movies[].torrents[]","fields":{"name":"^.title_long","infohash":"hash","size_bytes":"size_bytes","seeders":"seeds","leechers":"peers","category":{"const":"video"},"first_seen":"date_uploaded_unix","description_url":"^.url"}}];

/**
 * Which code this is: the first twelve hex of this file's own SHA-256, stamped
 * by `npm run build`.
 *
 * Most fixes travel in the feed and need no re-paste, but some live here (how
 * a release name is read, what the front page will show a stranger), and those
 * only arrive with a new file. `/api/v1/health` reports this so "did my paste
 * take" is a comparison rather than a guess.
 *
 * A hash and not a date, because the first attempt at this stamped the feed's
 * issue date, which does not move when only the code changes, so it read
 * identical across three code fixes and answered the question wrongly. The
 * source's own hash moves when and only when the source does.
 */
const BUILD = "5485c09560ff";

/** Everything the Worker reads from the environment, resolved once per request. */
function settings(env = {}) {
  const text = (name, fallback = "") => {
    const value = env[name];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  const number = (name, fallback) => {
    const value = Number(text(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const off = (name) => ["0", "false", "no", "off"].includes(text(name).toLowerCase());
  const on = (name) => ["1", "true", "yes", "on"].includes(text(name).toLowerCase());
  const list = (name) => text(name).split(/[\s,]+/).filter(Boolean);
  // A rate limiter is a binding, not a string: an object with `limit()`,
  // declared in wrangler config. A pasted Worker has none, and is not limited.
  const limiter = (name) => (env[name] && typeof env[name].limit === "function" ? env[name] : null);

  const only = list("TSP_INDEXES");
  const relayIndexes = text("TSP_RELAY_INDEXES");

  return {
    apikey: text("TSP_APIKEY", BAKED_APIKEY),
    showKey: !off("TSP_SHOW_KEY"),
    feedUrl: off("TSP_FEED") ? null : text("TSP_FEED_URL", DEFAULT_FEED_URL),
    only: only.length ? new Set(only) : null,
    also: new Set(list("TSP_ALSO")),
    // Hosted mode, section 1b: keys signed with a secret and stored nowhere,
    // an operator's key above them, limits and a cache in front, and a relay
    // behind for the indexes this address cannot reach.
    keySecret: text("TSP_KEY_SECRET"),
    keyDeny: new Set(list("TSP_KEY_DENY")),
    adminKey: text("TSP_ADMIN_KEY"),
    limiters: { search: limiter("TSP_RATE_SEARCH"), keys: limiter("TSP_RATE_KEYS") },
    cacheS: off("TSP_CACHE") ? 0 : number("TSP_CACHE", 600),
    relayUrl: text("TSP_RELAY_URL"),
    relayKey: text("TSP_RELAY_KEY"),
    relayIndexes: relayIndexes === "*" ? "*" : new Set(list("TSP_RELAY_INDEXES")),
    relayOnly: on("TSP_RELAY_ONLY"),
    nsfw: !off("TSP_NSFW"),
    browse: !off("TSP_BROWSE"),
    limit: number("TSP_LIMIT", 100),
    perIndexTimeoutS: number("TSP_TIMEOUT", 8),
    userAgent: text(
      "TSP_USER_AGENT",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ),
  };
}

/**
 * Compare two keys without letting the time taken say how much of the guess
 * was right. Length is not secret (a wrong length fails immediately), but the
 * bytes are.
 */
function keyMatches(given, expected) {
  if (!expected) return true; // no key configured: the deployment is open on purpose
  if (typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The key on a request: `?apikey=`, `X-Api-Key:`, or `Authorization: Bearer`. */
function requestKey(url, request) {
  const query = url.searchParams.get("apikey");
  if (query) return query;
  const header = request.headers.get("x-api-key");
  if (header) return header;
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1] : "";
}

// --- 1b. hosted mode: signed keys, the operator's key, limits ----------------
//
// A deployment for one person has one key, baked in or set. A deployment for
// strangers cannot: that is the same key for everyone, or a list of them. So
// with `TSP_KEY_SECRET` set, a key is `<id>.<signature>`, the signature an
// HMAC of the id under the secret, minted by `/api/v1/key` for whoever asks
// and checked by computing it again. Nothing is stored, nothing can leak but
// the secret, one key is refused by listing its id in `TSP_KEY_DENY`, and all
// of them by changing the secret.

const KEY_ID_HEX = 24;
const KEY_SIG_HEX = 32;
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret, text) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}

const signKeyId = async (secret, id) => (await hmacHex(secret, id)).slice(0, KEY_SIG_HEX);

/** A fresh signed key: a random id, its signature under the secret, kept by nobody. */
async function mintKey(secret) {
  const id = hex(crypto.getRandomValues(new Uint8Array(KEY_ID_HEX / 2)));
  return `${id}.${await signKeyId(secret, id)}`;
}

/** The id of a signed key that is the secret's own and not denied, else null. */
async function signedKeyId(given, settings) {
  const match = typeof given === "string" ? given.match(/^([0-9a-f]{24})\.([0-9a-f]{32})$/) : null;
  if (!match) return null;
  if (!keyMatches(match[2], await signKeyId(settings.keySecret, match[1]))) return null;
  return settings.keyDeny.has(match[1]) ? null : match[1];
}

/**
 * Who is asking. `ok` says whether they may; `id` is what a rate limiter
 * counts them as; `admin` is the operator, whose key is not limited and is
 * the only one a hosted deployment lets run a descriptor of its choosing.
 */
async function authorize(given, settings) {
  if (settings.adminKey && keyMatches(given, settings.adminKey)) return { ok: true, id: "admin", admin: true };
  if (settings.keySecret) {
    const id = await signedKeyId(given, settings);
    return id ? { ok: true, id, admin: false } : { ok: false };
  }
  if (!keyMatches(given, settings.apikey)) return { ok: false };
  return { ok: true, id: settings.apikey ? "key" : "open", admin: false };
}

/** `true` when a rate-limit binding says no. No binding, or nothing to count by, is no limit. */
async function limited(binding, key) {
  if (!binding || !key) return false;
  try {
    const { success } = await binding.limit({ key });
    return success === false;
  } catch {
    return false; // a limiter that fails does not take the search down with it
  }
}

// --- 2. the feed -------------------------------------------------------------

/** How long a fetched feed is served before another fetch is attempted. */
const FEED_REFRESH_MS = 60 * 60 * 1000;

/** How long a feed may go unrefreshed before the compiled copy is preferred. */
const FEED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** A colo-local memo, so most requests do no feed work at all. */
let feedMemo = { at: 0, catalogue: null, meta: null };

/**
 * What makes a fetched feed believable.
 *
 * Not a signature: this travels over HTTPS from GitHub Pages, and what stands
 * behind it is the repository, the same thing that stands behind the file you
 * pasted. What is checked here is that it is the right *kind* of document and
 * that it is not a replay of an old one: `serial` never goes backwards, and a
 * feed past its `expires_at` is not used at all.
 */
function readFeed(text, nowMs) {
  let feed;
  try {
    feed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!feed || typeof feed !== "object") return null;
  if (feed.tsp_feed_version !== 1) return null;
  if (!Array.isArray(feed.indexes) || !feed.indexes.length) return null;
  if (!Number.isInteger(feed.serial) || feed.serial < 0) return null;
  if (feed.expires_at && Date.parse(feed.expires_at) < nowMs) return null;

  const indexes = feed.indexes.filter((entry) => !descriptorProblem(entry));
  if (!indexes.length) return null;

  return {
    serial: feed.serial,
    issued_at: feed.issued_at || null,
    expires_at: feed.expires_at || null,
    upstream: feed.upstream || null,
    indexes,
  };
}

/**
 * Fetch the feed, or keep what we have.
 *
 * Failure is never fatal and never loud: a Worker that cannot reach GitHub
 * Pages goes on searching whatever it last believed, and failing that, the
 * copy compiled into it. The one thing that would be worse than stale data is
 * no data, and this is a search API: the answer to "I could not check" is to
 * carry on, not to stop.
 */
async function loadFeed(settings, nowMs, waitUntil) {
  const fresh = () => nowMs - feedMemo.at < FEED_REFRESH_MS;

  if (!settings.feedUrl) return { catalogue: BAKED_CATALOGUE, meta: { source: "compiled" } };
  if (feedMemo.catalogue && fresh()) return { catalogue: feedMemo.catalogue, meta: feedMemo.meta };

  const fetchFeed = async () => {
    try {
      const response = await fetch(settings.feedUrl, {
        cf: { cacheTtl: 900, cacheEverything: true },
        headers: { accept: "application/json" },
      });
      if (!response.ok) return false;
      const feed = readFeed(await response.text(), nowMs);
      if (!feed) return false;
      if (feedMemo.meta && feedMemo.meta.serial > feed.serial) return false; // never go backwards
      feedMemo = {
        at: nowMs,
        catalogue: feed.indexes,
        meta: { source: "feed", serial: feed.serial, issued_at: feed.issued_at, upstream: feed.upstream },
      };
      return true;
    } catch {
      return false;
    }
  };

  // A warm-but-stale memo answers now and refreshes behind the request; a cold
  // one is worth waiting for, because the alternative is a worse answer.
  if (feedMemo.catalogue && nowMs - feedMemo.at < FEED_MAX_AGE_MS) {
    if (waitUntil) waitUntil(fetchFeed());
    else await fetchFeed();
    return { catalogue: feedMemo.catalogue, meta: feedMemo.meta };
  }

  await fetchFeed();
  if (feedMemo.catalogue) return { catalogue: feedMemo.catalogue, meta: feedMemo.meta };
  return { catalogue: BAKED_CATALOGUE, meta: { source: "compiled" } };
}

/**
 * The indexes a request will actually ask, after the deployment's own filters.
 *
 * `nsfw` stays on the descriptor as a fact about the index, a caller may well
 * want to know, and `TSP_NSFW=0` turns those off, but it does not hold one
 * back by default. Whoever deploys this Worker chose to; it is their search
 * API, and a default that quietly withheld part of the catalogue would be this
 * project deciding something that is not its to decide.
 */
function chosen(catalogue, settings) {
  return catalogue.filter((index) => {
    if (settings.only) return settings.only.has(index.id);
    if (index.nsfw && !settings.nsfw) return false;
    // `TSP_ALSO` turns one on that the catalogue has off, without `TSP_INDEXES`'s
    // price of freezing the list: what the feed adds later still arrives.
    if (index.enabled === false) return Boolean(settings.also?.has(index.id));
    return true;
  });
}

// --- 3. descriptors ----------------------------------------------------------

/**
 * A descriptor says four things: where to ask, how to ask, where the rows are,
 * and which part of a row feeds which TSP field. Everything in `catalogue/` is
 * one of these, and nothing in this file knows the name of a single site.
 *
 *   {
 *     "id": "knaben", "kind": "json", "site": "https://knaben.org",
 *     "origins": ["https://api.knaben.org"],
 *     "request": { "method": "POST", "path": "/v1", "body": { "query": "{q}" } },
 *     "rows": "hits",
 *     "fields": { "name": "title", "seeders": "seeders" }
 *   }
 *
 * A field is a path, a list of paths tried in order, or an object with a
 * little more to say:
 *
 *   "title"                      the value at that path
 *   ["hash", "magnetUrl"]        the first of those that yields anything
 *   { "sel": "td.n a", "attr": "href" }        HTML: an attribute, not text
 *   { "from": "size", "nonzero": true }        0 means "not recorded"
 *   { "from": "id", "template": "…/{value}" }  build a URL around it
 *   { "from": "cat", "prefix": 1, "map": {…} } classify by leading digits
 *   { "from": "detail", "re": "([a-f0-9]{40})" } pull it out with a pattern
 *
 * One more key, for an index that does not search: `"match": "name"` keeps
 * only rows whose name carries every word of the query, so an index that
 * answers everything with its latest uploads contributes what fits and not
 * the rest.
 *
 * The grammar is small on purpose. A site that needs more than this needs a
 * person to look at it, and saying so is better than a descriptor that half
 * works.
 */

const KINDS = new Set(["json", "rss", "html"]);

/** The TSP fields a descriptor may fill, and what each must end up as. */
const TARGETS = {
  name: "text",
  infohash: "infohash",
  magnet: "text",
  size_bytes: "bytes",
  seeders: "count",
  leechers: "count",
  files: "count",
  category: "category",
  first_seen: "date",
  description_url: "url",
  torrent_url: "url",
};

const CATEGORIES = new Set(["video", "audio", "software", "archive", "document", "image", "other"]);

/**
 * What to ask when the caller asks for nothing.
 *
 * TSP says an empty `q` means "browse the whole index", and a metasearch has
 * no index to browse, it has a list of other people's. Asked an empty query,
 * each of them does something different: most return nothing, and the one or
 * two that answer with their own latest uploads then account for the entire
 * result. That is how a category filter with no search term came back as
 * sixteen Japanese anime releases with no seeders, one index answered, so one
 * index *was* the answer.
 *
 * So an empty query becomes a real one: a technical marker common enough that
 * every index has plenty of it, chosen for the category asked for. The term
 * used is reported back as `browse_query`, because rows that nobody asked for
 * need to explain themselves.
 */
const BROWSE_TERMS = {
  video: ["2160p", "1080p", "x265"],
  audio: ["flac", "mp3", "discography"],
  software: ["x64", "iso", "repack"],
  document: ["epub", "pdf", "ebook"],
  image: ["wallpapers", "imageset", "photos"],
  archive: ["rar", "zip", "7z"],
  other: ["1080p", "flac", "x64"],
};

/** How long one browse term stands before the next takes over. */
const BROWSE_ROTATION_MS = 60 * 60 * 1000;

/** The term standing in for an empty query, rotating so a browse is not always the same page. */
function browseQuery(category, nowMs) {
  const terms = BROWSE_TERMS[category] || BROWSE_TERMS.video;
  return terms[Math.floor(nowMs / BROWSE_ROTATION_MS) % terms.length];
}

/**
 * Upstream's category words, in TSP's.
 *
 * These are two different vocabularies and it is worth being clear about why.
 * Upstream's `supportedCategories` describes *what a site covers*, a place
 * that carries anime, or games, or porn. TSP's `category` describes *what a
 * file is*, video, audio, a document. "Anime" is not a kind of file; it is a
 * kind of video. Reading one as the other is how an index that declares
 * `Other` ends up stamping the word "other" on every album it returns.
 *
 * `other` is deliberately absent. Upstream uses it for "this site does not
 * classify its results", which is a statement about the site and says nothing
 * about a row, so it maps to no category at all, and the name is asked
 * instead.
 */
const UPSTREAM_CATEGORY = {
  movies: "video",
  series: "video",
  anime: "video",
  porn: "video",
  music: "audio",
  apps: "software",
  games: "software",
  books: "document",
};

/**
 * Why a descriptor cannot be used, or "" if it can.
 *
 * Run on everything the feed offers as well as everything in the catalogue: a
 * feed is a file fetched off the internet, and the Worker's willingness to
 * believe it stops at the point where it would run something malformed.
 */
function descriptorProblem(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.id || "")) return "id must be lowercase letters, digits and dashes";
  if (!KINDS.has(entry.kind)) return `kind must be one of ${[...KINDS].join(", ")}`;

  const origins = entry.origins;
  if (!Array.isArray(origins) || !origins.length) return "origins must be a non-empty array";
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return `origin ${origin} is not a URL`;
    }
    if (parsed.protocol !== "https:") return `origin ${origin} is not https`;
  }

  const request = entry.request || {};
  const method = (request.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) return "request.method must be GET or POST";
  if (method === "POST" && entry.kind !== "json") return "only json indexes may POST";
  if (request.path !== undefined && typeof request.path !== "string") return "request.path must be a string";
  if (request.query !== undefined && (typeof request.query !== "object" || Array.isArray(request.query))) {
    return "request.query must be an object";
  }

  if (entry.rows !== undefined && typeof entry.rows !== "string") return "rows must be a string";
  if (entry.kind === "html" && !entry.rows) return "html indexes must say where the rows are";

  const fields = entry.fields;
  if (!fields || typeof fields !== "object") return "fields must be an object";
  if (!fields.name) return "fields.name is required: a row without a name is not a result";
  if (!fields.infohash && !fields.magnet) return "fields must yield an infohash or a magnet";

  for (const [target, spec] of Object.entries(fields)) {
    if (!TARGETS[target]) return `unknown field ${target}`;
    const problem = specProblem(spec, entry.kind);
    if (problem) return `fields.${target}: ${problem}`;
  }

  if (entry.categories !== undefined && !Array.isArray(entry.categories)) return "categories must be an array";
  if (entry.match !== undefined && entry.match !== "name") return 'match must be "name", or absent';
  return "";
}

/** Why one field spec cannot be used, or "". */
function specProblem(spec, kind) {
  if (typeof spec === "string") return spec ? "" : "empty path";
  if (Array.isArray(spec)) {
    if (!spec.length) return "empty list";
    for (const one of spec) {
      const problem = specProblem(one, kind);
      if (problem) return problem;
    }
    return "";
  }
  if (!spec || typeof spec !== "object") return "must be a string, a list, or an object";

  if (spec.const !== undefined) return "";
  const source = kind === "html" ? spec.sel : spec.from;
  if (source === undefined && spec.from === undefined && spec.sel === undefined && spec.cell === undefined) return "needs a path";
  if (source !== undefined && typeof source !== "string") return `${kind === "html" ? "sel" : "from"} must be a string`;
  if (spec.attr !== undefined && typeof spec.attr !== "string") return "attr must be a string";
  if (spec.cell !== undefined && !Number.isInteger(spec.cell)) return "cell must be a whole number";
  if (spec.template !== undefined && typeof spec.template !== "string") return "template must be a string";
  if (spec.map !== undefined && (typeof spec.map !== "object" || Array.isArray(spec.map))) return "map must be an object";
  if (spec.prefix !== undefined && !Number.isInteger(spec.prefix)) return "prefix must be a whole number";
  if (spec.re !== undefined) {
    if (typeof spec.re !== "string") return "re must be a string";
    try {
      new RegExp(spec.re);
    } catch {
      return `re is not a valid pattern: ${spec.re}`;
    }
  }
  return "";
}

// --- 4. reading answers ------------------------------------------------------

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Tags whose opening implies the close of something already open. Real pages omit these. */
const IMPLIED_CLOSE = {
  li: new Set(["li"]),
  p: new Set(["p"]),
  option: new Set(["option"]),
  tr: new Set(["td", "th", "tr"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  thead: new Set(["td", "th", "tr"]),
  tbody: new Set(["td", "th", "tr"]),
  tfoot: new Set(["td", "th", "tr"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
};

/**
 * What an implied close may not reach past. A `<tr>` inside a cell belongs to
 * the table in that cell, not to the one around it.
 */
const ROW_SCOPE = new Set(["table", "thead", "tbody", "tfoot"]);
const LIST_SCOPE = new Set(["ul", "ol", "dl", "select", "table"]);
const SCOPES = {
  li: LIST_SCOPE,
  dt: LIST_SCOPE,
  dd: LIST_SCOPE,
  option: LIST_SCOPE,
  p: new Set(["div", "table", "td", "th", "li", "blockquote"]),
  tr: ROW_SCOPE,
  td: ROW_SCOPE,
  th: ROW_SCOPE,
  thead: ROW_SCOPE,
  tbody: ROW_SCOPE,
  tfoot: ROW_SCOPE,
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#039": "'" };

function unescapeHtml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body) => {
    if (ENTITIES[body] !== undefined) return ENTITIES[body];
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function attributes(raw) {
  const attrs = {};
  for (const found of raw.matchAll(/([-\w:]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = found[1].toLowerCase();
    if (name === "/") continue;
    const value = found[3] ?? found[4] ?? found[5] ?? "";
    attrs[name] = unescapeHtml(value);
  }
  return attrs;
}

/**
 * A tolerant HTML tree.
 *
 * Not a compliant parser and not trying to be. Torrent sites emit markup that
 * a compliant parser would spend its time recovering from, and all a
 * descriptor ever asks of a page is "the cells of these rows", so this keeps
 * a stack, honours the few implied-close rules that real tables rely on, and
 * closes whatever is still open at the end. Scripts and comments are dropped
 * before parsing, because a `<` inside a script is not a tag and pretending
 * otherwise is how these parsers usually go wrong.
 */
function parseHtml(html) {
  const source = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const tagPattern = /<(\/?)([a-zA-Z][-\w:]*)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>/g;
  let at = 0;
  let found;

  const addText = (text) => {
    if (!text) return;
    const clean = unescapeHtml(text);
    if (clean.trim()) top().children.push({ text: clean });
  };

  while ((found = tagPattern.exec(source))) {
    addText(source.slice(at, found.index));
    at = tagPattern.lastIndex;

    const closing = found[1] === "/";
    const tag = found[2].toLowerCase();

    if (closing) {
      const depth = stack.findLastIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }

    // A new `<tr>` closes the row before it and everything still open inside
    // that row. Two things make this more than popping the top: a page that
    // omits `</td>` usually omits `</a>` too, so the match can be several
    // levels up; and a table nested in a cell must not close the row of the
    // table around it. So walk up to the *outermost* match, and stop dead at
    // anything that scopes rows or items.
    const implied = IMPLIED_CLOSE[tag];
    if (implied) {
      let cut = -1;
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (SCOPES[tag].has(stack[depth].tag)) break;
        if (implied.has(stack[depth].tag)) cut = depth;
      }
      if (cut > 0) stack.length = cut;
    }

    const node = { tag, attrs: attributes(found[3] || ""), children: [], parent: top() };
    top().children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(found[0])) stack.push(node);
  }
  addText(source.slice(at));

  return root;
}

/** Every element under a node, in document order. */
function* elements(node) {
  for (const child of node.children) {
    if (child.tag === undefined) continue;
    yield child;
    yield* elements(child);
  }
}

/** All text under a node, whitespace collapsed. */
function textOf(node) {
  if (node.text !== undefined) return node.text;
  return node.children
    .map(textOf)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subset of CSS a descriptor may use: tag, `.class`, `#id`, `[attr]`,
 * `[attr=value]`, `:nth-of-type(n)`, joined by descendant or `>`, and comma
 * for alternatives. Enough to name a cell in a table; small enough to read.
 */
function compileSelector(selector) {
  return String(selector)
    .split(",")
    .map((branch) => {
      const steps = [];
      let combinator = " ";
      for (const piece of branch.trim().split(/\s+/)) {
        if (piece === ">") {
          combinator = ">";
          continue;
        }
        if (!piece) continue;
        steps.push({ combinator, test: compileCompound(piece) });
        combinator = " ";
      }
      return steps;
    })
    .filter((steps) => steps.length);
}

function compileCompound(piece) {
  const tag = (piece.match(/^[a-zA-Z][-\w]*/) || [null])[0];
  const classes = [...piece.matchAll(/\.([-\w]+)/g)].map((m) => m[1]);
  const id = (piece.match(/#([-\w]+)/) || [])[1];
  const attrs = [...piece.matchAll(/\[([-\w:]+)(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)].map((m) => ({
    name: m[1],
    op: m[2],
    value: m[3] ?? m[4] ?? m[5] ?? "",
  }));
  const nth = Number((piece.match(/:nth-of-type\((\d+)\)/) || [])[1]) || null;
  const first = /:first-child\b/.test(piece);

  return (node) => {
    if (tag && node.tag !== tag.toLowerCase()) return false;
    if (id && node.attrs.id !== id) return false;
    for (const wanted of classes) {
      const has = (node.attrs.class || "").split(/\s+/).includes(wanted);
      if (!has) return false;
    }
    for (const { name, op, value } of attrs) {
      const actual = node.attrs[name];
      if (actual === undefined) return false;
      if (!op) continue;
      if (op === "=" && actual !== value) return false;
      if (op === "*=" && !actual.includes(value)) return false;
      if (op === "^=" && !actual.startsWith(value)) return false;
      if (op === "$=" && !actual.endsWith(value)) return false;
      if (op === "~=" && !actual.split(/\s+/).includes(value)) return false;
    }
    if (nth || first) {
      const siblings = (node.parent?.children || []).filter((sibling) => sibling.tag === node.tag);
      const at = siblings.indexOf(node);
      if (first && at !== 0) return false;
      if (nth && at !== nth - 1) return false;
    }
    return true;
  };
}

/** Does `node` satisfy a compiled branch, reading right to left through its ancestors? */
function matchesBranch(node, steps) {
  let at = steps.length - 1;
  if (!steps[at].test(node)) return false;
  let current = node.parent;
  at -= 1;
  while (at >= 0) {
    const { combinator, test } = steps[at + 1];
    if (combinator === ">") {
      if (!current || current.tag === "#root" || !steps[at].test(current)) return false;
      current = current.parent;
      at -= 1;
      continue;
    }
    let walker = current;
    while (walker && walker.tag !== "#root" && !steps[at].test(walker)) walker = walker.parent;
    if (!walker || walker.tag === "#root") return false;
    current = walker.parent;
    at -= 1;
  }
  return true;
}

/** Every element under `root` matching `selector`, in document order. */
function queryAll(root, selector) {
  const branches = compileSelector(selector);
  if (!branches.length) return [];
  const found = [];
  for (const node of elements(root)) {
    if (branches.some((steps) => matchesBranch(node, steps))) found.push(node);
  }
  return found;
}

/** RSS is XML, and XML is not HTML: case matters, CDATA exists, nothing is implied. */
function parseXml(xml) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const source = String(xml).replace(/<\?[\s\S]*?\?>/g, "");

  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let at = 0;
  let found;

  const addText = (text) => {
    if (text && text.trim()) top().children.push({ text: unescapeHtml(text) });
  };

  while ((found = token.exec(source))) {
    addText(source.slice(at, found.index));
    at = token.lastIndex;

    if (found[1] !== undefined) {
      top().children.push({ text: found[1] });
      continue;
    }
    const tag = found[3];
    if (found[2] === "/") {
      const depth = stack.findLastIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }
    const node = { tag, attrs: attributes(found[4] || ""), children: [], parent: top() };
    top().children.push(node);
    if (!found[5]) stack.push(node);
  }
  addText(source.slice(at));
  return root;
}

/**
 * A value out of a JSON row. `""` is the row itself; `a.b.0` walks objects and
 * arrays alike. Anything missing is `undefined`, never an exception, a row
 * that lacks a field is ordinary, not exceptional.
 */
function jsonAt(row, path) {
  if (!path) return row;
  let at = row;
  for (const step of String(path).split(".")) {
    if (at === null || at === undefined) return undefined;
    at = at[step];
  }
  return at;
}

/**
 * A value out of an XML element. `title` is a child's text; `enclosure@url` is
 * an attribute; `attr[name=seeders]@value` picks the child that carries a
 * given attribute, which is how Torznab-shaped feeds say everything.
 */
function xmlAt(row, path) {
  const [route, attr] = String(path).split("@");
  let nodes = [row];
  for (const step of route.split("/").filter(Boolean)) {
    const predicate = step.match(/^([\w:.-]+)\[([\w:.-]+)=([^\]]+)\]$/);
    const tag = predicate ? predicate[1] : step;
    const next = [];
    for (const node of nodes) {
      for (const child of node.children) {
        if (child.tag !== tag) continue;
        if (predicate && child.attrs[predicate[2]] !== predicate[3]) continue;
        next.push(child);
      }
    }
    if (!next.length) return undefined;
    nodes = next;
  }
  if (!nodes.length) return undefined;
  if (attr) return nodes[0].attrs[attr];
  return nodes[0] === row ? textOf(row) : textOf(nodes[0]);
}

/**
 * A value out of an HTML row: a selector, and either its text or one
 * attribute. `cell` stands in for a selector where there is nothing to select
 * by, an unclassed table, where the only thing distinguishing size from
 * seeders is which column it sits in. Negative counts from the end, because
 * these tables grow columns on the left more often than on the right.
 */
function htmlAt(row, selector, attr, cell) {
  let node;
  if (cell !== undefined) {
    const cells = row.children.filter((child) => child.tag === "td" || child.tag === "th");
    node = cells.at(cell < 0 ? cell : cell - 1);
    if (node && selector) node = queryAll(node, selector)[0];
  } else {
    node = selector ? queryAll(row, selector)[0] : row;
  }
  if (!node) return undefined;
  return attr ? node.attrs[attr] : textOf(node);
}

/** The raw value one spec names, before any coercion. */
function pick(row, spec, kind, origin) {
  if (spec === undefined || spec === null) return undefined;

  if (Array.isArray(spec)) {
    for (const one of spec) {
      const value = pick(row, one, kind, origin);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  if (typeof spec === "string") {
    if (kind === "json") return jsonAt(row, spec);
    if (kind === "rss") return xmlAt(row, spec);
    return htmlAt(row, spec, null, undefined);
  }

  if (spec.const !== undefined) return spec.const;

  const path = kind === "html" ? spec.sel : spec.from;
  let value = kind === "html" ? htmlAt(row, path, spec.attr, spec.cell) : pick(row, path === undefined ? "" : path, kind, origin);
  if (kind !== "html" && spec.attr && value && typeof value === "object") value = value[spec.attr];
  if (value === undefined || value === null || value === "") return undefined;

  if (spec.re) {
    const found = String(value).match(new RegExp(spec.re));
    if (!found) return undefined;
    value = found[1] !== undefined ? found[1] : found[0];
  }
  if (spec.prefix) value = String(value).slice(0, spec.prefix);
  if (spec.map) {
    const mapped = spec.map[String(value)];
    if (mapped === undefined) return undefined;
    value = mapped;
  }
  if (spec.nonzero && Number(value) === 0) return undefined;
  if (spec.template) value = spec.template.replace(/\{value\}/g, String(value));
  return value;
}

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** "1.5 GiB", "700 MB", "1073741824", all of them, into bytes. */
function toBytes(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const text = String(value).replace(/,/g, " ").trim();
  const found = text.match(/([\d.]+)\s*([kmgt]?i?b)\b/i);
  if (found) {
    const size = Number(found[1]) * (UNITS[found[2].toLowerCase()] || 1);
    return Number.isFinite(size) && size > 0 ? Math.round(size) : undefined;
  }
  const plain = Number(text.replace(/\s/g, ""));
  return Number.isFinite(plain) && plain > 0 ? Math.round(plain) : undefined;
}

/** A whole count, or undefined. Zero is a fact and survives; "N/A" does not. */
function toCount(value) {
  const found = String(value).replace(/[,\s]/g, "").match(/^-?\d+/);
  if (!found) return undefined;
  const count = Number(found[0]);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

const HASH = /\b([a-fA-F0-9]{40})\b/;
const BASE32 = /\b([a-zA-Z2-7]{32})\b/;

/**
 * A 40-hex infohash out of a hash, a magnet, or a link that carries one.
 *
 * Forty zeros is not one. It is what apibay puts in its "No results returned"
 * placeholder, which is a row in every other respect, and which reached a
 * client as a torrent named exactly that.
 */
function toInfohash(value) {
  const text = String(value);
  const hex = text.match(HASH);
  if (hex) return /^0{40}$/.test(hex[1]) ? undefined : hex[1].toLowerCase();
  const magnet = text.match(/urn:btih:([^&\s]+)/i);
  if (magnet) {
    const hexInMagnet = magnet[1].match(/^[a-fA-F0-9]{40}$/);
    if (hexInMagnet) return magnet[1].toLowerCase();
    if (BASE32.test(magnet[1])) return magnet[1].toUpperCase(); // base32: kept as-is, still identifies the torrent
  }
  return undefined;
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const AGO = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

/** A moment, as ISO 8601, out of whatever the site felt like printing. */
function toDate(value, nowMs) {
  if (typeof value === "number" || /^\d{9,13}$/.test(String(value).trim())) {
    const epoch = Number(value);
    const ms = epoch > 1e11 ? epoch : epoch * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const text = String(value).trim();
  if (!text) return undefined;

  const ago = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (ago) return new Date(nowMs - Number(ago[1]) * AGO[ago[2].toLowerCase()]).toISOString();
  if (/^(today|just now)/i.test(text)) return new Date(nowMs).toISOString();
  if (/^yesterday/i.test(text)) return new Date(nowMs - AGO.day).toISOString();

  const named = text.match(/([a-zA-Z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(named[3]), month, Number(named[2]))).toISOString();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** An absolute https URL, resolved against the origin that answered. */
function toUrl(value, origin) {
  try {
    const url = new URL(String(value), origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const EXTENSION = /\.([a-z0-9]{2,5})$/iu;

const EXTENSION_CATEGORY = {
  mkv: "video", mp4: "video", avi: "video", mov: "video", m4v: "video",
  wmv: "video", mpg: "video", mpeg: "video", flv: "video", webm: "video",
  mp3: "audio", flac: "audio", wav: "audio", aac: "audio", ogg: "audio",
  m4a: "audio", opus: "audio", alac: "audio", wma: "audio", ape: "audio",
  pdf: "document", epub: "document", mobi: "document", azw3: "document",
  djvu: "document", cbr: "document", cbz: "document", chm: "document",
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image",
  tiff: "image", webp: "image", psd: "image", svg: "image",
  exe: "software", msi: "software", dmg: "software", apk: "software",
  deb: "software", rpm: "software", pkg: "software", appimage: "software",
  rar: "archive", zip: "archive", "7z": "archive", tar: "archive",
  gz: "archive", bz2: "archive", xz: "archive", tgz: "archive",
};

/**
 * Ordered rules; the first family with a hit wins. Video markers come first
 * because scene video names are the most distinctive, and because a game or an
 * application essentially never carries a resolution or an SxxEyy tag.
 */
const CLASSIFY_RULES = [
  ["video", /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dolby[. _-]?vision|x26[45]|h[. _-]?26[45]|hevc|avc|xvid|divx|av1|blu[. _-]?ray|bd(?:rip|remux|mux)|br[. _-]?rip|web[. _-]?(?:dl|rip)|hd(?:tv|rip|cam)|dvd(?:rip|scr|r)?|remux|telesync|cam[. _-]?rip|s\d{1,2}[. _-]?e\d{1,3}|\d{1,2}x\d{2}|season[. _-]?\d{1,2}|complete[. _-]series|episode[. _-]?\d{1,3}|dts(?:[. _-]?hd)?|ddp?\d[. _-]?\d|truehd|atmos)\b/i],
  // `v0`/`v2` are LAME presets and `cbr` a bitrate mode, but bare they are also
  // every application's version number and every comic-book archive. They only
  // count next to something that already says audio: a rare miss beats filing
  // Photoshop under music.
  ["audio", /\b(flac|mp3|aac|alac|ogg|opus|wav|ape|dsd|\d{2,3}\s?kbps|(?:mp3|lame)[. _-]?v[02]|vbr|discography|anthology|album|ep|single|soundtrack|ost|bootleg|audiobook|audio[. _-]?book|vinyl|cd[. _-]?(?:rip|q|da)|web[. _-]?flac)\b/i],
  ["software", /\b(x64|x86|win(?:32|64|dows)?|macos|osx|linux|ubuntu|debian|fedora|arch|v\d+(?:\.\d+)+|build[. _-]?\d+|portable|multilingual|activated|crack(?:ed|fix)?|keygen|patch|repack|pre[. _-]?activated|iso|fitgirl|dodi|codex|plaza|skidrow|reloaded|empress|razor1911|tenoke|gog|steam|denuvo|update[. _-]?only|dlc)\b/i],
  ["document", /\b(ebook|e[. _-]?book|epub|pdf|mobi|azw3|retail|magazine|comics?|manga|\d(?:st|nd|rd|th)[. _-]?edition|textbook|novel|paperback)\b/i],
  ["image", /\b(wallpapers?|imageset|image[. _-]?pack|photos?|pics|pictures|artwork|hi[. _-]?res[. _-]?scans)\b/i],
  ["archive", /\b(rar|zip|7z|tar|tgz|gz|bz2|xz)\b/i],
];

/**
 * Best-effort TSP category for a release name, or null if unreadable.
 *
 * Null means "no idea", which is not the same as "no". Every rule keys off a
 * technical marker, a resolution, a codec, a format, and a great many real
 * releases carry none: a bare title and a year, most of what a DHT crawl
 * returns. Saying nothing is the honest answer for those, and it leaves the
 * index's own word for the site to stand.
 */
function classifyName(name) {
  if (!name) return null;
  const extension = EXTENSION.exec(name.trim());
  if (extension) {
    const category = EXTENSION_CATEGORY[extension[1].toLowerCase()];
    if (category) return category;
  }
  for (const [category, rule] of CLASSIFY_RULES) {
    if (rule.test(name)) return category;
  }
  return null;
}

/** One raw value onto its TSP type, or absent. */
function coerce(target, value, { origin, nowMs }) {
  if (value === undefined || value === null || value === "") return undefined;
  switch (TARGETS[target]) {
    case "count":
      return toCount(value);
    case "bytes":
      return toBytes(value);
    case "infohash":
      return toInfohash(value);
    case "date":
      return toDate(value, nowMs);
    case "url":
      return toUrl(value, origin);
    case "category": {
      const category = String(value).toLowerCase();
      return CATEGORIES.has(category) ? category : undefined;
    }
    default: {
      const text = String(value).replace(/\s+/g, " ").trim();
      return text || undefined;
    }
  }
}

// --- 5. the pipeline ---------------------------------------------------------

/** The rows an answer contains, as handles the field pickers understand. */
/**
 * The rows of a JSON answer, which are not always a plain array.
 *
 * `hits` is one; `data.movies[].torrents[]` is the other kind, an API that
 * nests the files inside the thing they are files of. A `[]` step iterates,
 * and each row it produces can still see the object it came out of, under the
 * key `^`, because that is usually where the name is: a YTS torrent knows its
 * quality and its size, and nothing else about the film.
 */
function jsonRows(root, path) {
  let level = [{ value: root, parent: null }];

  for (const raw of String(path || "").split(".")) {
    const flatten = raw.endsWith("[]");
    const step = flatten ? raw.slice(0, -2) : raw;
    const next = [];
    for (const { value, parent } of level) {
      const at = step ? value?.[step] : value;
      if (at === undefined || at === null) continue;
      if (flatten && Array.isArray(at)) for (const one of at) next.push({ value: one, parent: value });
      else next.push({ value: at, parent });
    }
    level = next;
  }

  // A path with no `[]` in it named the array itself.
  if (level.length === 1 && Array.isArray(level[0].value)) return level[0].value;

  return level.map(({ value, parent }) =>
    parent && value && typeof value === "object" && !Array.isArray(value) ? { ...value, "^": parent } : value,
  );
}

function rowsFrom(kind, body, rows) {
  if (kind === "json") return jsonRows(JSON.parse(body), rows || "");
  const tree = kind === "rss" ? parseXml(body) : parseHtml(body);
  if (kind === "rss") {
    // Every RSS feed keeps its entries in the same place, so a descriptor only
    // says so when it is one of the few that does not.
    const [route] = (rows || "rss/channel/item").split("@");
    const found = [];
    const walk = (node, steps) => {
      if (!steps.length) return found.push(node);
      const [head, ...rest] = steps;
      for (const child of node.children) if (child.tag === head) walk(child, rest);
    };
    walk(tree, route.split("/").filter(Boolean));
    return found;
  }
  return queryAll(tree, rows);
}

/**
 * Substitute `{q}` and `{limit}` into a template, encoding for where it lands:
 * a path (`encode: true`), a query string (`false`), or the text of a JSON
 * body (`"json"`), where a quote in the query must not end the string.
 */
function fill(template, query, limit, { encode }) {
  const enc = encode === "json" ? (text) => JSON.stringify(text).slice(1, -1) : encode ? encodeURIComponent : (text) => text;
  return String(template)
    .replace(/\{q\}/g, enc(query))
    .replace(/\{q\+\}/g, enc(query.trim().split(/\s+/).join("+")))
    .replace(/\{limit\}/g, String(limit));
}

/** The URL and init one descriptor needs, against one of its origins. */
function buildRequest(descriptor, origin, query, settings) {
  const request = descriptor.request || {};
  const url = new URL(fill(request.path || "/", query, settings.limit, { encode: true }), origin);

  for (const [name, value] of Object.entries(request.query || {})) {
    url.searchParams.set(name, fill(value, query, settings.limit, { encode: false }));
  }

  const headers = {
    "user-agent": settings.userAgent,
    accept: descriptor.kind === "json" ? "application/json, */*" : descriptor.kind === "rss" ? "application/rss+xml, application/xml, text/xml, */*" : "text/html, */*",
    "accept-language": "en-US,en;q=0.9",
    ...(request.headers || {}),
  };

  const method = (request.method || "GET").toUpperCase();
  if (method !== "POST") return { url: url.toString(), init: { method, headers } };

  // A body value that is exactly "{limit}" becomes the number, not the string
  // "100": JSON has numbers, and Knaben answered 422 to the string.
  const body = JSON.parse(fill(JSON.stringify(request.body || {}).replace(/"\{limit\}"/g, String(settings.limit)), query, settings.limit, { encode: "json" }));
  return { url: url.toString(), init: { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) } };
}

/** One row, read through a descriptor. Null when it lacks what a result needs. */
function readRow(descriptor, row, origin, nowMs) {
  const out = { indexer: descriptor.id };
  for (const [target, spec] of Object.entries(descriptor.fields)) {
    const value = coerce(target, pick(row, spec, descriptor.kind, origin), { origin, nowMs });
    if (value !== undefined) out[target] = value;
  }

  if (!out.name) return null;
  if (!out.infohash && out.magnet) out.infohash = toInfohash(out.magnet);
  if (!out.infohash) return null;
  if (!out.magnet) out.magnet = `magnet:?xt=urn:btih:${out.infohash}&dn=${encodeURIComponent(out.name)}`;

  // Where a category comes from, in order of how much it knows about *this
  // row*. What the index said about the row is a fact. The name is evidence,
  // and specific to the row, so it outranks the site, an anime index still
  // carries the occasional soundtrack. What the site covers comes last, and
  // only when it covers one thing, translated out of upstream's vocabulary
  // into TSP's.
  if (!out.category) out.category = classifyName(out.name) || undefined;
  if (!out.category && Array.isArray(descriptor.categories) && descriptor.categories.length === 1) {
    // Only a word that translates. `other` does not, and must not fall through
    // untranslated: upstream means "this site does not classify", and copying
    // it here would say "this file is none of the above", which is a claim,
    // and a wrong one. An absent category means nobody could tell, which is
    // what actually happened.
    const declared = descriptor.categories[0];
    const only = UPSTREAM_CATEGORY[declared] ?? (declared !== "other" && CATEGORIES.has(declared) ? declared : null);
    if (only) out.category = only;
  }
  return out;
}

/**
 * Ask one index, over each of its origins in turn.
 *
 * Origins are mirrors of the same site, and a site being unreachable is the
 * normal condition of this project rather than an error worth propagating: a
 * search that reaches nine of ten indexes is a good search. Every failure is
 * caught and returned as a note, so `/api/v1/search` can say what it could not
 * reach without failing on account of it.
 */
/**
 * Whether a row is about what was asked, for an index that cannot be trusted
 * to check. `"match": "name"` on a descriptor says the index ignores the
 * query, or may, and that a row whose name lacks any word of it is dropped
 * here. EZTV's API is the case in point: it answers every query with its
 * latest hundred uploads, so a search for a band came back as that week's
 * television. Not applied to every index, because one that searches actors
 * or descriptions returns names that lack the words and are still right.
 */
function matchesQuery(descriptor, row, query) {
  if (descriptor.match !== "name") return true;
  const fold = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const name = ` ${fold(row.name)} `;
  return fold(query).split(" ").filter(Boolean).every((term) => name.includes(term));
}

async function askIndex(descriptor, query, settings, nowMs) {
  const problems = [];

  // One clock for the index, not one per origin. The setting is documented
  // as the wait for one index, and a search is as slow as its slowest index:
  // with a clock per origin, YTS's four dead mirrors held a search for thirty
  // seconds. A mirror that fails fast still leaves time for the next one; a
  // mirror that hangs uses up the index's turn, which is the right outcome.
  const deadline = Date.now() + settings.perIndexTimeoutS * 1000;

  for (const origin of descriptor.origins) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      problems.push(`${new URL(origin).host}: not tried, no time left`);
      continue;
    }
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), remaining);
    try {
      const { url, init } = buildRequest(descriptor, origin, query, settings);
      const response = await fetch(url, { ...init, signal: control.signal, redirect: "follow" });
      if (!response.ok) {
        problems.push(`${new URL(origin).host} answered ${response.status}`);
        continue;
      }
      const body = await response.text();
      const rows = rowsFrom(descriptor.kind, body, descriptor.rows)
        .slice(0, settings.limit)
        .map((row) => readRow(descriptor, row, origin, nowMs))
        .filter((row) => row && matchesQuery(descriptor, row, query));
      return { id: descriptor.id, rows, origin, problems };
    } catch (error) {
      problems.push(`${new URL(origin).host}: ${error.name === "AbortError" ? "timed out" : String(error.message || error).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { id: descriptor.id, rows: [], origin: null, problems };
}

/**
 * Merge what the indexes said.
 *
 * The same torrent turns up on several sites, and the infohash is what says
 * so. Where they disagree, the row with more seeders wins the numbers, it is
 * the more recently observed, and every index that carried it is listed, so a
 * caller can see how widely a thing is available.
 */
function merge(answers) {
  const byHash = new Map();

  for (const answer of answers) {
    for (const row of answer.rows) {
      const seen = byHash.get(row.infohash);
      if (!seen) {
        byHash.set(row.infohash, { ...row, indexers: [row.indexer] });
        continue;
      }
      if (!seen.indexers.includes(row.indexer)) seen.indexers.push(row.indexer);
      if ((row.seeders ?? -1) > (seen.seeders ?? -1)) {
        Object.assign(seen, row, { indexers: seen.indexers });
      }
      for (const field of ["size_bytes", "files", "category", "first_seen", "description_url", "torrent_url"]) {
        if (seen[field] === undefined && row[field] !== undefined) seen[field] = row[field];
      }
    }
  }

  return [...byHash.values()]
    .map(({ indexer, ...row }) => row)
    .sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
}

/** A TSP torrent object, out of a merged row. */
function toTorrent(row, scrapedAt) {
  const torrent = { magnet: row.magnet, infohash: row.infohash, name: row.name };
  for (const field of ["size_bytes", "files", "category", "seeders", "leechers", "first_seen"]) {
    if (row[field] !== undefined) torrent[field] = row[field];
  }
  torrent.scraped_at = scrapedAt;
  if (row.torrent_url) torrent.torrent_url = row.torrent_url;
  if (row.description_url) torrent.description_url = row.description_url;
  if (row.indexers?.length) torrent.sources = [...row.indexers].sort();
  return torrent;
}

/**
 * Ask another deployment of this file to run an index.
 *
 * Whether a site answers is a fact about the address asking, and a few sites
 * that answer an ordinary server refuse Cloudflare's addresses. So a hosted
 * deployment can name a relay, `TSP_RELAY_URL`: another copy of this Worker
 * standing somewhere else, and `TSP_RELAY_INDEXES` to send it. The relay runs
 * the descriptor through `/api/v1/relay` and hands back the answer `askIndex`
 * would have given, rows and all; the merge cannot tell the difference.
 */
const viaRelay = (index, settings) => Boolean(settings.relayUrl) && (settings.relayIndexes === "*" || settings.relayIndexes.has(index.id));

async function askRelay(descriptor, query, settings) {
  const problem = (text) => ({ id: descriptor.id, rows: [], origin: null, problems: [`relay: ${text}`] });
  const url = new URL("/api/v1/relay", settings.relayUrl);
  url.searchParams.set("d", JSON.stringify(descriptor));
  url.searchParams.set("q", query);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), (settings.perIndexTimeoutS + 2) * 1000);
  try {
    const response = await fetch(url, { headers: { "x-api-key": settings.relayKey, accept: "application/json" }, signal: control.signal });
    if (!response.ok) return problem(`answered ${response.status}`);
    const got = await response.json();
    return {
      id: descriptor.id,
      rows: Array.isArray(got.rows) ? got.rows : [],
      origin: got.origin ?? null,
      problems: Array.isArray(got.problems) ? got.problems.map((text) => `relay: ${text}`) : [],
    };
  } catch (error) {
    return problem(error.name === "AbortError" ? "timed out" : String(error.message || error).slice(0, 120));
  } finally {
    clearTimeout(timer);
  }
}

/** Ask every chosen index at once. What comes back is what the cache keeps: merged rows, and who answered. */
async function gather(query, catalogue, settings, nowMs) {
  const indexes = chosen(catalogue, settings).filter((index) => !query.indexers || query.indexers.has(index.id));
  const scrapedAt = new Date(nowMs).toISOString();

  // Nothing was asked, so something has to be. `TSP_BROWSE=0` keeps the strict
  // reading instead: an empty query, an empty answer.
  const browsing = query.terms ? "" : settings.browse ? browseQuery(query.cat, nowMs) : "";
  if (!query.terms && !browsing) return { rows: [], engines: [], failures: {}, browsing: "", scrapedAt };

  const terms = browsing || query.terms;
  const answers = await Promise.all(
    indexes.map((index) => (viaRelay(index, settings) ? askRelay(index, terms, settings) : askIndex(index, terms, settings, nowMs))),
  );

  const failures = {};
  for (const one of answers) {
    if (!one.origin && one.problems.length) failures[one.id] = one.problems;
  }
  return { rows: merge(answers), engines: answers.filter((one) => one.origin).map((one) => one.id), failures, browsing, scrapedAt };
}

/** TSP's search result object, out of what was gathered, for the page that was asked for. */
function answer(query, gathered, started) {
  let rows = gathered.rows;
  if (query.cat) rows = rows.filter((row) => row.category === query.cat);
  if (query.minSeeders) rows = rows.filter((row) => (row.seeders ?? 0) >= query.minSeeders);

  const body = {
    query: query.q,
    count: rows.length,
    limit: query.limit,
    offset: query.offset,
    took_ms: Date.now() - started,
    torrents: rows.slice(query.offset, query.offset + query.limit).map((row) => toTorrent(row, gathered.scrapedAt)),
    engines: gathered.engines,
  };
  // Not TSP. Without it, an empty search comes back full of rows with nothing
  // to say why, and "you asked for everything, so it picked something" is not
  // guessable from the rows.
  if (gathered.browsing) body.browse_query = gathered.browsing;
  if (Object.keys(gathered.failures || {}).length) body.failures = gathered.failures;
  return body;
}

/** A search, fresh. */
async function search(query, catalogue, settings, nowMs) {
  const started = Date.now();
  return answer(query, await gather(query, catalogue, settings, nowMs), started);
}

/**
 * A search, remembered.
 *
 * The same question arrives many times an hour, and each arrival was asking a
 * dozen sites again. So a merged answer is kept for `TSP_CACHE` seconds, keyed
 * on everything that could change it, and paged from the copy: the second page
 * of a query costs nothing, and a popular query is answered in the time it
 * takes to read it back. Cloudflare's cache is per data centre, and only real
 * on a custom domain: on a workers.dev address these calls do nothing,
 * quietly, and every search is fresh. An answer nobody gave, every index
 * silent, is not kept; the next asker deserves a retry.
 */
function cacheKey(query, settings) {
  const asked = {
    q: query.terms,
    cat: query.cat,
    indexers: query.indexers ? [...query.indexers].sort() : null,
    only: settings.only ? [...settings.only].sort() : null,
    also: [...(settings.also || [])].sort(),
    nsfw: settings.nsfw,
    browse: settings.browse,
    limit: settings.limit,
  };
  return `https://cache.tsp.invalid/v1/search?${new URLSearchParams({ asked: JSON.stringify(asked) })}`;
}

async function cachedSearch(query, catalogue, settings, nowMs, waitUntil) {
  const started = Date.now();
  const cache = settings.cacheS > 0 ? globalThis.caches?.default : null;
  const key = cache ? cacheKey(query, settings) : null;

  if (cache) {
    try {
      const held = await cache.match(key);
      if (held) return { body: answer(query, await held.json(), started), hit: true };
    } catch {
      // a cache that cannot be read is no cache
    }
  }

  const gathered = await gather(query, catalogue, settings, nowMs);
  if (cache && gathered.engines.length) {
    try {
      const keep = cache
        .put(key, new Response(JSON.stringify(gathered), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${settings.cacheS}` } }))
        .catch(() => {});
      if (waitUntil) waitUntil(keep);
      else await keep;
    } catch {
      // nor is one that cannot be written
    }
  }
  return { body: answer(query, gathered, started), hit: false };
}

// --- 6. routes ---------------------------------------------------------------

const json = (status, body) =>
  new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });

const tooMany = () => {
  const response = json(429, { error: "too many requests; try again in a moment" });
  response.headers.set("retry-after", "10");
  return response;
};

const whole = (value, fallback, cap) => {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, cap) : fallback;
};

/** What a search request is asking for. */
function readQuery(url, settings) {
  const indexers = (url.searchParams.get("indexers") || "").split(/[\s,]+/).filter(Boolean);
  return {
    q: url.searchParams.get("q") ?? "",
    terms: (url.searchParams.get("q") ?? "").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim(),
    cat: CATEGORIES.has(url.searchParams.get("cat") || "") ? url.searchParams.get("cat") : "",
    limit: whole(url.searchParams.get("limit"), 50, settings.limit),
    offset: whole(url.searchParams.get("offset"), 0, 10_000),
    minSeeders: whole(url.searchParams.get("min_seeders"), 0, 1e6),
    indexers: indexers.length ? new Set(indexers) : null,
  };
}

/**
 * The page a fresh deployment shows: this Worker's URL, and its key.
 *
 * It exists because a Worker you have just deployed is otherwise silent about
 * the two things you need to use it, and reading them back out of the
 * Cloudflare dashboard is where people give up. The page is public, it has
 * to be, since a deployment that could only be checked by someone holding the
 * key is a deployment nobody can check, and by default it shows the key to
 * anyone who opens it. That was not always so: the first version showed it
 * only to a request that already carried it, on the grounds that a secret
 * printed to every visitor is not a secret. In practice the person who has
 * just deployed opens the URL Cloudflare hands them and sees dots, which is
 * where *they* give up. A workers.dev address carries a random suffix and is
 * not guessable; what a leaked one buys a stranger is searches on your quota.
 * `TSP_SHOW_KEY=0` restores the stricter page, for anyone who weighs it
 * differently.
 */
function setupPage(url, settings, catalogue, meta, known) {
  const base = `${url.protocol}//${url.host}`;
  const hosted = Boolean(settings.keySecret);
  const shown = !hosted && Boolean(settings.apikey) && (known || settings.showKey);
  const example = `${base}/api/v1/search?q=ubuntu${shown ? `&apikey=${encodeURIComponent(settings.apikey)}` : hosted || settings.apikey ? "&apikey=YOUR-KEY" : ""}`;
  const enabled = chosen(catalogue, settings);
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TSP torrent search API</title>
<style>
  :root { color-scheme: light dark; --ink:#111; --dim:#666; --line:#dcdcdc; --bg:#fff; --box:#f6f6f6; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e8e8e8; --dim:#9a9a9a; --line:#333; --bg:#151515; --box:#1e1e1e; } }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:44rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  p.lede { color:var(--dim); margin:0 0 2rem; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
       margin:2rem 0 .5rem; font-weight:600; }
  code, .box { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .box { display:block; background:var(--box); border:1px solid var(--line); border-radius:6px;
         padding:.7rem .8rem; overflow-x:auto; white-space:pre; user-select:all; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td { border-top:1px solid var(--line); padding:.35rem .5rem .35rem 0; }
  td.k { color:var(--dim); white-space:nowrap; }
  a { color:inherit; }
  footer { margin-top:2.5rem; color:var(--dim); font-size:13px; }
</style></head><body><main>
<h1>TSP torrent search API</h1>
<p class="lede">This Worker is running. Below is everything you need to point a client at it.</p>

<h2>URL</h2>
<span class="box">${escape(base)}</span>

<h2>API key</h2>
${
  hosted
    ? `<p>Keys here are made on request, signed and kept by nobody: one for you, as many as you like, each rate-limited on its own.</p>
<p><button id="get" type="button">Get a key</button></p>
<span class="box" id="key">(press the button, or GET /api/v1/key)</span>
<p class="hint">Save it. Your client sends it as <code>?apikey=</code>, <code>X-Api-Key:</code> or <code>Authorization: Bearer</code>.</p>`
    : `<span class="box">${
        !settings.apikey
          ? "(none: this deployment is open to anyone who finds it)"
          : shown
            ? escape(settings.apikey)
            : "•••••••••••••••• (add ?apikey=… to this URL to check it)"
      }</span>${
        !settings.apikey || known
          ? ""
          : shown
            ? `\n<p class="hint">Shown to anyone who opens this page, so the address is the secret. <code>TSP_SHOW_KEY=0</code> shows it only to a request that already carries it.</p>`
            : `\n<p class="hint">Not shown to a visitor who does not already have it. It is the key baked into the file, or whatever <code>TSP_APIKEY</code> is set to; unset <code>TSP_SHOW_KEY</code> to show it to anyone.</p>`
      }`
}

<h2>Try it</h2>
<span class="box" id="example">${escape(example)}</span>
<p><a id="open" href="${escape(example)}">Open that search</a></p>

<h2>Searching ${enabled.length} of ${catalogue.length} indexes</h2>
<table><tbody>
${enabled
  .map(
    (index) =>
      `<tr><td>${index.site ? `<a href="${escape(index.site)}" rel="noopener nofollow">${escape(index.name || index.id)}</a>` : escape(index.name || index.id)}${index.nsfw ? ' <span class="k">adult</span>' : ""}</td><td class="k">${escape(index.kind)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>

<footer>
<p>Catalogue: <strong>${escape(meta.source)}</strong>${meta.serial !== undefined ? ` · serial ${escape(meta.serial)}` : ""}${meta.issued_at ? ` · issued ${escape(meta.issued_at)}` : ""}.
Refreshed hourly from the feed, so this list changes without you re-pasting anything.</p>
<p>Sites come from <a href="https://github.com/prajwalch/TorrentSearch" rel="noopener">prajwalch/TorrentSearch</a>${meta.upstream?.commit ? ` at <code>${escape(String(meta.upstream.commit).slice(0, 12))}</code>` : ""}.
Source: <a href="https://github.com/momzv2022-ctrl/tsp-torrent-search-api" rel="noopener">momzv2022-ctrl/tsp-torrent-search-api</a>.</p>
</footer>
</main>${
  hosted
    ? `
<script>
document.getElementById("get").onclick = async () => {
  const button = document.getElementById("get");
  button.disabled = true;
  try {
    const got = await (await fetch("/api/v1/key", { method: "POST" })).json();
    document.getElementById("key").textContent = got.apikey || got.error || "no key came back";
    if (got.example) {
      document.getElementById("example").textContent = got.example;
      document.getElementById("open").href = got.example;
    }
  } finally {
    button.disabled = false;
  }
};
</script>`
    : ""
}</body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = settings(env);
    const nowMs = Date.now();
    const waitUntil = ctx?.waitUntil?.bind(ctx);
    const minting = url.pathname === "/api/v1/key";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "x-api-key, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" },
      });
    }
    if (request.method !== "GET" && !(request.method === "POST" && minting)) return json(405, { error: "method not allowed" });

    // A relay works for other deployments and for nobody else: no page, no
    // search, no key to hand out, nothing for a stranger who finds the address.
    if (config.relayOnly && url.pathname !== "/api/v1/relay" && url.pathname !== "/api/v1/health") return json(404, { error: "not found" });

    const { catalogue, meta } = await loadFeed(config, nowMs, waitUntil);
    const ip = request.headers.get("cf-connecting-ip") || "";

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const known = !config.keySecret && keyMatches(requestKey(url, request), config.apikey);
      return new Response(setupPage(url, config, catalogue, meta, known), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/v1/health") {
      return json(200, {
        ok: true,
        build: BUILD,
        mode: config.relayOnly ? "relay" : config.keySecret ? "hosted" : config.apikey ? "keyed" : "open",
        catalogue: { source: meta.source, serial: meta.serial ?? null, issued_at: meta.issued_at ?? null, upstream: meta.upstream ?? null },
        indexes: { known: catalogue.length, enabled: chosen(catalogue, config).length },
      });
    }

    // A hosted deployment hands a key to whoever asks, so the asking is
    // rate-limited by address; the key itself costs nothing to make or keep.
    if (minting) {
      if (!config.keySecret) return json(404, { error: "this deployment has one key, set by whoever deployed it; its front page shows it" });
      if (await limited(config.limiters.keys, `ip:${ip}`)) return tooMany();
      const apikey = await mintKey(config.keySecret);
      const base = `${url.protocol}//${url.host}`;
      return json(200, { apikey, url: base, example: `${base}/api/v1/search?q=ubuntu&apikey=${apikey}` });
    }

    const who = await authorize(requestKey(url, request), config);
    if (!who.ok) return json(401, { error: "bad or missing api key" });

    if (url.pathname === "/api/v1/indexers") {
      return json(200, {
        indexers: catalogue.map((index) => ({
          id: index.id,
          name: index.name || index.id,
          site: index.site || null,
          kind: index.kind,
          categories: index.categories || [],
          enabled: chosen(catalogue, config).some((one) => one.id === index.id),
          upstream: index.upstream || null,
        })),
      });
    }

    // Run a descriptor that is not in the catalogue yet, against the live site.
    // This is how a new index gets written: try it here, read the rows it
    // produces, then commit the descriptor that produced them. `/api/v1/relay`
    // is the same run answered whole, for another deployment to merge. Either
    // fetches whatever URL the descriptor names, on this deployment's behalf,
    // so a hosted deployment lets only the operator's key do it.
    if (url.pathname === "/api/v1/try" || url.pathname === "/api/v1/relay") {
      if (config.keySecret && !who.admin) return json(403, { error: "this takes the operator's key, not one from the front page" });
      let descriptor;
      try {
        descriptor = JSON.parse(url.searchParams.get("d") || "");
      } catch {
        return json(400, { error: "d must be a descriptor as JSON" });
      }
      const problem = descriptorProblem(descriptor);
      if (problem) return json(400, { error: problem });
      const ran = await askIndex(descriptor, readQuery(url, config).terms || "ubuntu", config, nowMs);
      if (url.pathname === "/api/v1/relay") return json(200, ran);
      return json(200, { id: ran.id, origin: ran.origin, problems: ran.problems, count: ran.rows.length, rows: ran.rows.slice(0, 10) });
    }

    if (url.pathname === "/api/v1/search") {
      if (!who.admin && ((await limited(config.limiters.search, `key:${who.id}`)) || (await limited(config.limiters.search, `ip:${ip}`)))) return tooMany();
      const { body, hit } = await cachedSearch(readQuery(url, config), catalogue, config, nowMs, waitUntil);
      const response = json(200, body);
      response.headers.set("x-tsp-cache", hit ? "hit" : "miss");
      return response;
    }

    return json(404, { error: "not found" });
  },
};

export const __testing = {
  BAKED_CATALOGUE,
  CATEGORIES,
  answer,
  askIndex,
  askRelay,
  authorize,
  cacheKey,
  cachedSearch,
  gather,
  hmacHex,
  limited,
  mintKey,
  signedKeyId,
  browseQuery,
  buildRequest,
  chosen,
  classifyName,
  coerce,
  descriptorProblem,
  keyMatches,
  loadFeed,
  merge,
  parseHtml,
  parseXml,
  pick,
  jsonRows,
  queryAll,
  readFeed,
  readQuery,
  readRow,
  rowsFrom,
  search,
  settings,
  setupPage,
  textOf,
  toBytes,
  toDate,
  toInfohash,
  toTorrent,
  resetFeedMemo: () => {
    feedMemo = { at: 0, catalogue: null, meta: null };
  },
};
