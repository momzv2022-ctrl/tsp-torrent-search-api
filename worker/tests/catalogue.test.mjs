/**
 * The catalogue is data, so these are the tests that data can fail: every
 * descriptor is one the Worker would accept, every descriptor still reads its
 * own recorded response, and `docs/` is what the sources currently say.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

import { __testing } from "../src/worker.js";
import { build, catalogue, published, replay } from "../tools/build.mjs";

const { descriptorProblem, pick, rowsFrom } = __testing;
const REPO = new URL("../..", import.meta.url).pathname;

test("every descriptor is one a Worker would accept", () => {
  const descriptors = catalogue();
  assert.ok(descriptors.length >= 14, "the catalogue should not have shrunk by accident");
  for (const descriptor of descriptors) {
    assert.equal(descriptorProblem(descriptor), "", `catalogue/${descriptor.id}.json`);
  }
});

test("every descriptor still reads its own recorded response", () => {
  for (const descriptor of catalogue()) {
    const { rows, skipped } = replay(descriptor);
    assert.equal(skipped, false, `${descriptor.id} has no fixture, every descriptor needs one`);
    assert.ok(rows > 0, `${descriptor.id} read no rows`);
  }
});

test("no field spec is dead", () => {
  // A selector or pattern that extracts nothing is not a syntax error and does
  // not stop the rows arriving, so nothing else here would notice, the row
  // simply comes back missing a field, or worse, quietly filled in from a
  // weaker source. Knaben shipped a category pattern with one backslash too
  // many and read nothing for it; the name classifier covered for it, and the
  // replay passed because rows were still produced.
  for (const descriptor of catalogue()) {
    const body = readFileSync(join(REPO, "worker", "tests", "fixtures", descriptor.fixture), "utf8");
    const rows = rowsFrom(descriptor.kind, body, descriptor.rows);
    for (const [target, spec] of Object.entries(descriptor.fields)) {
      const found = rows.some((row) => {
        const value = pick(row, spec, descriptor.kind, descriptor.origins[0]);
        return value !== undefined && value !== null && value !== "";
      });
      assert.ok(found, `${descriptor.id}: fields.${target} extracts nothing from ${descriptor.fixture}`);
    }
  }
});

test("ids are unique, and each names the upstream site it stands for", () => {
  const descriptors = catalogue();
  const ids = descriptors.map((one) => one.id);
  assert.equal(new Set(ids).size, ids.length, "two descriptors share an id");

  const census = JSON.parse(readFileSync(join(REPO, "upstream", "providers.json"), "utf8"));
  const known = new Set(census.providers.map((one) => one.id));
  for (const descriptor of descriptors) {
    if (descriptor.upstream === null) continue; // ours by choice, never upstream's
    assert.ok(known.has(descriptor.upstream), `${descriptor.id} claims upstream ${descriptor.upstream}, which the census does not carry`);
  }
});

test("the feed carries what a Worker runs, and nothing about how we maintain it", () => {
  const [descriptor] = catalogue().filter((one) => one.fixture);
  const clean = published(descriptor);
  assert.ok(!("fixture" in clean));
  assert.ok(!("note" in clean));
  assert.equal(clean.id, descriptor.id);
});

test("docs/ is current, build it and commit it", () => {
  const read = (file) => readFileSync(join(REPO, "docs", file), "utf8");
  const before = { worker: read("worker.js"), page: read("index.html") };
  const { digest } = build({ log: () => {} });
  assert.equal(read("worker.js"), before.worker, "docs/worker.js is stale, run `npm run build`");
  assert.equal(read("index.html"), before.page, "docs/index.html is stale, run `npm run build`");
  assert.equal(read("worker.js.sha256").split(" ")[0], digest);
});

test("the published worker carries the catalogue and no key", () => {
  const worker = readFileSync(join(REPO, "docs", "worker.js"), "utf8");
  assert.ok(worker.includes('const BAKED_APIKEY = "";'), "published worker must ship without a key");
  assert.ok(!worker.includes("/* @__CATALOGUE__ */ []"), "published worker must have the catalogue spliced in");
  const inlined = worker.match(/const BAKED_CATALOGUE = (\[.*?\]);\n/s);
  assert.ok(inlined, "the compiled catalogue should be findable");
  assert.equal(JSON.parse(inlined[1]).length, catalogue().length);
});

test("the probe sends a Worker only what a Worker runs", async () => {
  // `fixture`, `note` and `probe` are how this repository maintains a
  // descriptor, not how one is run. Sending them would put a local filename
  // into a URL for no reason, and the Worker's validator does not know them.
  const { forWire } = await import("../tools/probe.mjs");
  const [descriptor] = catalogue().filter((one) => one.fixture);
  const wire = forWire({ ...descriptor, probe: { at: "2026-09-09", answered: true } });

  assert.ok(!("fixture" in wire) && !("note" in wire) && !("probe" in wire));
  assert.equal(descriptorProblem(wire), "", "and what is left must still validate");
});

test("the build stamp tracks the code, not the catalogue", () => {
  // It exists to answer "did my paste take", and the first attempt at it
  // stamped the feed's issue date, which does not move when only the code
  // changes, so it read identical across three code fixes and answered the
  // question wrongly. It must be the source's own hash.
  const stamp = build({ log: () => {} }).build;
  assert.match(stamp, /^[0-9a-f]{12}$/);

  const source = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");
  const expected = createHash("sha256").update(source).digest("hex").slice(0, 12);
  assert.equal(stamp, expected, "it is the hash of worker/src/worker.js, before anything is spliced in");

  const published = readFileSync(join(REPO, "docs", "worker.js"), "utf8");
  assert.ok(published.includes(`const BUILD = "${expected}";`), "and the published file carries it");
});
