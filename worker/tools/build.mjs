/**
 * Everything the world sees, into `docs/`.
 *
 *     npm run build
 *
 *   docs/worker.js         the file people paste, catalogue inlined
 *   docs/worker.js.sha256  its hash, in `shasum -a 256` format
 *   docs/index.html        the setup page, which writes a key into that file
 *   docs/feed.json         the catalogue, which every deployment refetches
 *   docs/.nojekyll         so GitHub Pages serves it verbatim
 *
 * `docs/` on the branch rather than a CI artifact, because GitHub Pages will
 * serve a folder with no workflow at all: Settings → Pages → "Deploy from a
 * branch" → `main` → `/docs`. Nothing here needs a build server, and the
 * worker.js published is a copy of the source with one array filled in, so its
 * hash is the hash of something you can read.
 *
 * Two things this refuses to publish, both of them ways the project could
 * quietly stop being trustworthy:
 *
 *   a source with a key already in it, that would hand one key to everyone
 *   a descriptor that no longer reads its own recorded response, that is a
 *   broken index shipped to every deployment on the next refresh
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __testing } from "../src/worker.js";

const { descriptorProblem, readRow, rowsFrom } = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, "docs");
const CATALOGUE = join(REPO, "catalogue");
const FIXTURES = join(REPO, "worker", "tests", "fixtures");
const SOURCE_PATH = join(REPO, "worker", "src", "worker.js");
const CENSUS_PATH = join(REPO, "upstream", "providers.json");
const PAGE_PATH = join(HERE, "page.html");
const WRANGLER_PATH = join(OUT, "wrangler.jsonc");

/** The line the setup page fills in. It must ship empty. */
const BLANK_KEY = 'const BAKED_APIKEY = "";';

/** Where the catalogue is spliced into the published worker.js. */
const CATALOGUE_MARKER = "/* @__CATALOGUE__ */ []";

/** Where the code's identity is stamped, so a deployment can say which code it runs. */
const BUILD_MARKER = '/* @__BUILD__ */ "source"';

/**
 * How long a feed stands before a Worker stops believing it.
 *
 * Long enough that a quiet month is not an outage, short enough that a feed
 * nobody has touched in half a year stops being presented as current. A Worker
 * past this date falls back to the copy compiled into it, which still works,
 * it is just older.
 */
const EXPIRES_DAYS = 180;

/** Keys that describe how the repository maintains a descriptor, not how a Worker runs it. */
const BUILD_ONLY = new Set(["fixture", "note"]);

export function catalogue() {
  return readdirSync(CATALOGUE)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(CATALOGUE, file), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A descriptor as the feed carries it: what a Worker needs, and nothing else. */
export function published(descriptor) {
  return Object.fromEntries(Object.entries(descriptor).filter(([key]) => !BUILD_ONLY.has(key)));
}

/**
 * Read a descriptor's recorded response with the descriptor, and insist it
 * still yields rows.
 *
 * This is the only test that matters for a catalogue: a selector that has
 * rotted is not a syntax error, and nothing else in the project would notice.
 */
export function replay(descriptor) {
  if (!descriptor.fixture) return { rows: 0, skipped: true };
  const path = join(FIXTURES, descriptor.fixture);
  if (!existsSync(path)) throw new Error(`${descriptor.id}: fixture ${descriptor.fixture} is missing`);
  const body = readFileSync(path, "utf8");
  const rows = rowsFrom(descriptor.kind, body, descriptor.rows)
    .map((row) => readRow(descriptor, row, descriptor.origins[0], Date.parse("2026-01-01T00:00:00Z")))
    .filter(Boolean);
  if (!rows.length) throw new Error(`${descriptor.id}: reads no rows out of ${descriptor.fixture} any more`);
  return { rows: rows.length, skipped: false };
}

/** The census, if a sync has been run. Provenance for the feed, not a requirement. */
function census() {
  if (!existsSync(CENSUS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CENSUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What `docs/wrangler.jsonc` says the Worker is called and which runtime date
 * it runs under. The one-click link the page builds carries both, so they are
 * read from the file the other one-click route deploys: two routes, one
 * answer. Whole-line `//` comments only, which is all that file uses.
 */
function deployConfig() {
  const text = readFileSync(WRANGLER_PATH, "utf8");
  const config = JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
  if (!/^[a-z0-9-]+$/.test(config.name) || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)) {
    throw new Error("docs/wrangler.jsonc needs a name of [a-z0-9-] and a yyyy-mm-dd compatibility_date");
  }
  return config;
}

/** The feed as last published, or null. */
function lastFeed() {
  const path = join(OUT, "feed.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What this feed's serial and dates should be.
 *
 * A serial only moves when the catalogue actually says something different,
 * and the issue date moves with it. Building twice from the same sources
 * therefore produces the same bytes, which is what lets a test asssert that
 * `docs/` is current without that test itself making it stale, and it keeps a
 * scheduled build from publishing a new serial every night to say nothing.
 */
function stamps(previous, indexes, now) {
  const same = previous && JSON.stringify(previous.indexes) === JSON.stringify(indexes);
  if (same) return { serial: previous.serial, issued_at: previous.issued_at, expires_at: previous.expires_at };

  const issued = new Date(now);
  const iso = (date) => date.toISOString().replace(/\.\d+Z$/, "Z");
  return {
    serial: (previous?.serial || 0) + 1,
    issued_at: iso(issued),
    expires_at: iso(new Date(issued.getTime() + EXPIRES_DAYS * 864e5)),
  };
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The worker as a JavaScript string literal, safe inside a `<script>`.
 *
 * The HTML parser reads a script block's text before JavaScript does, so `</`,
 * `<!--` and `<script` each have to be broken with a backslash JavaScript
 * ignores, this file contains all three, since it parses HTML and serves a
 * page. The browser then sees no sequence, and the program sees the same bytes.
 */
function inlineLiteral(text) {
  return JSON.stringify(text)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--")
    .replace(/-->/g, "--\\>")
    .replace(/<script/gi, (found) => `<\\${found.slice(1)}`);
}

export function build({ now = new Date(), log = console.log } = {}) {
  const source = readFileSync(SOURCE_PATH, "utf8");

  const keyLines = source.split(BLANK_KEY).length - 1;
  if (keyLines !== 1) {
    throw new Error(`worker/src/worker.js must carry \`${BLANK_KEY}\` exactly once, not ${keyLines} times: the published file ships without a key.`);
  }
  if (!source.includes(CATALOGUE_MARKER)) {
    throw new Error(`worker/src/worker.js has lost its \`${CATALOGUE_MARKER}\` marker: nothing would be compiled in.`);
  }
  if (!source.includes(BUILD_MARKER)) {
    throw new Error(`worker/src/worker.js has lost its \`${BUILD_MARKER}\` marker: deployments could not report their build.`);
  }

  const descriptors = catalogue();
  if (!descriptors.length) throw new Error("catalogue/ is empty");

  let replayed = 0;
  for (const descriptor of descriptors) {
    const problem = descriptorProblem(descriptor);
    if (problem) throw new Error(`catalogue/${descriptor.id}.json: ${problem}`);
    if (!replay(descriptor).skipped) replayed += 1;
  }

  const indexes = descriptors.map(published);
  const upstream = census();

  const feed = {
    "//": "The catalogue of tsp-torrent-search-api. Built from catalogue/*.json by `npm run build`; every deployment refetches it hourly. Data only.",
    tsp_feed_version: 1,
    ...stamps(lastFeed(), indexes, now),
    upstream: upstream ? { ...upstream.upstream, providers: upstream.count, synced_at: upstream.synced_at } : null,
    count: indexes.length,
    indexes,
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "feed.json"), `${JSON.stringify(feed, null, 2)}\n`);
  writeFileSync(join(OUT, ".nojekyll"), "");

  // The identity of the *code*, taken before anything is spliced in, so it
  // moves when and only when the source does, a catalogue change must not
  // look like a new build, and a code change must not hide behind an unchanged
  // one.
  const build = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const worker = source
    .replace(CATALOGUE_MARKER, JSON.stringify(indexes))
    .replace(BUILD_MARKER, JSON.stringify(build));
  writeFileSync(join(OUT, "worker.js"), worker);
  const digest = createHash("sha256").update(worker).digest("hex");
  writeFileSync(join(OUT, "worker.js.sha256"), `${digest}  worker.js\n`);

  // What a fresh deployment actually searches. This has to track `chosen()` in
  // the Worker: a page that counted differently would promise a search the
  // Worker does not make. Adult indexes are in the default set, and `nsfw` is
  // shown in the table so nobody has to find that out from the results.
  const enabled = indexes.filter((index) => index.enabled !== false);
  const rows = enabled
    .map(
      (index) =>
        `    <tr><td>${index.site ? `<a href="${escape(index.site)}" rel="noopener nofollow">${escape(index.name || index.id)}</a>` : escape(index.name || index.id)}${index.nsfw ? ' <span class="k">adult</span>' : ""}</td><td class="k">${escape(index.kind)}</td><td class="k">${escape((index.categories || []).slice(0, 3).join(", ") || "?")}</td></tr>`,
    )
    .join("\n");

  const deploy = deployConfig();
  const page = readFileSync(PAGE_PATH, "utf8")
    .replace("__WORKER_SOURCE__", () => inlineLiteral(worker))
    .replace(/__DEPLOY_NAME__/g, deploy.name)
    .replace(/__COMPAT_DATE__/g, deploy.compatibility_date)
    .replace(/__WORKER_SHA256__/g, digest)
    .replace(/__INDEX_ROWS__/g, () => rows)
    .replace(/__INDEX_COUNT__/g, String(enabled.length))
    .replace(/__CATALOGUE_COUNT__/g, String(indexes.length))
    .replace(/__UPSTREAM_COUNT__/g, String(upstream?.count ?? "?"))
    .replace(/__UPSTREAM_COMMIT__/g, escape(upstream?.upstream?.commit?.slice(0, 12) ?? "?"))
    .replace(/__SIZE_HINT__/g, `${Math.round(worker.length / 1024)} KiB`)
    .replace(/__SERIAL__/g, String(feed.serial))
    .replace(/__ISSUED_AT__/g, feed.issued_at);
  writeFileSync(join(OUT, "index.html"), page);

  log(`docs/worker.js      ${(worker.length / 1024).toFixed(1)} KiB  build ${build}`);
  log(`docs/feed.json      serial ${feed.serial}, ${indexes.length} indexes (${enabled.length} searched by a fresh deployment), ${replayed} replayed`);
  log(`docs/index.html     the setup page`);
  if (upstream) log(`upstream            ${upstream.count} sites at ${upstream.upstream.commit.slice(0, 12)}`);
  else log(`upstream            no census yet, run \`npm run sync\``);

  return { feed, digest, build };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    build();
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
}
