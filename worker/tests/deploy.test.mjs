/**
 * The "Deploy to Cloudflare" button reads `docs/` as a repository of its own,
 * so these are the tests that folder can fail: it must deploy the published
 * worker, it must ask for a key and never suggest one, and it must not lose
 * the dashboard's settings on the next build.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const DOCS = join(REPO, "docs");

/** wrangler.jsonc with its comments taken out. Whole-line comments only, which is all the file uses. */
function wranglerConfig() {
  const text = readFileSync(join(DOCS, "wrangler.jsonc"), "utf8");
  return JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));
}

/** A dotenv file's declarations: `NAME=value` lines, comments and blanks dropped. */
function declarations(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("the button deploys the published worker, under a name a URL can carry", () => {
  const config = wranglerConfig();
  assert.equal(config.main, "worker.js", "main must be the file next to it, a subdirectory deploy sees nothing outside docs/");
  assert.ok(existsSync(join(DOCS, config.main)));
  assert.match(config.name, /^[a-z0-9-]{1,63}$/, "the name becomes a workers.dev subdomain label");
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Date.parse(config.compatibility_date) <= Date.now(), "a compatibility date in the future is refused at deploy");
  assert.equal(config.workers_dev, true, "the Worker's own page shows its workers.dev URL, so there has to be one");
});

test("a rebuild keeps what was set in the dashboard", () => {
  // Settings are documented as "Settings → Variables and Secrets". Without
  // keep_vars, wrangler makes the dashboard match the config file on every
  // deploy, and the config file has no vars, so the first push to the copied
  // repository would quietly turn TSP_NSFW=0 back on.
  const config = wranglerConfig();
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars, undefined, "vars written here would be offered as defaults by the form; settings belong in the dashboard");
});

test("the form asks for a key, and suggests none", () => {
  // The form pre-fills what is written after the `=`, and a pre-filled key is
  // a shared key. It reads `.env.example` the same way, so that file must not
  // appear either, and a real .dev.vars or .env must never be committed.
  assert.deepEqual(declarations(join(DOCS, ".dev.vars.example")), ["TSP_APIKEY="], "exactly one secret, with nothing after the `=`");
  for (const stray of [".env.example", ".env", ".dev.vars"]) {
    assert.ok(!existsSync(join(DOCS, stray)), `docs/${stray} must not exist`);
  }
  for (const ignore of [".gitignore", join("docs", ".gitignore")]) {
    const lines = readFileSync(join(REPO, ignore), "utf8").split("\n");
    assert.ok(lines.includes(".dev.vars") && lines.includes(".env"), `${ignore} must ignore a real .dev.vars and .env`);
  }
});

test("the form has a sentence to show beside the key, and nothing to run", () => {
  const pkg = JSON.parse(readFileSync(join(DOCS, "package.json"), "utf8"));
  assert.ok(pkg.cloudflare?.bindings?.TSP_APIKEY?.description);
  assert.equal(pkg.type, "module", "this file shadows the repository's for docs/worker.js, so it has to say what Node would otherwise guess");
  assert.equal(pkg.scripts, undefined, "a build or deploy script here would be run by Workers Builds; there is nothing to build");
  assert.equal(pkg.dependencies, undefined, "nothing to install either");
});

test("the one-click link is built from the same file the button deploys", () => {
  // The page builds the Workers Playground's deploy link itself. Its Worker
  // name and compatibility date are filled in by the build from
  // docs/wrangler.jsonc, so the two routes cannot drift apart.
  const page = readFileSync(join(REPO, "worker", "tools", "page.html"), "utf8");
  assert.ok(page.includes("https://dash.cloudflare.com/workers-and-pages/deploy/playground/__DEPLOY_NAME__#"), "the link must be the dashboard's playground-deploy route, named by the build");
  assert.ok(page.includes('compatibility_date: "__COMPAT_DATE__"'), "the metadata part must carry the build's compatibility date");
  assert.ok(page.includes("function lzCompress("), "the compressor must be inlined, the page has no dependencies to fetch");
});
