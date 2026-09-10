/**
 * The census.
 *
 * Upstream is a Kotlin project that will keep being edited by people who have
 * never heard of this one, so the reader has to be judged against real sources
 * rather than ones written to suit it, these fixtures are copied verbatim out
 * of prajwalch/TorrentSearch. What is asserted is that the facts upstream
 * states outright come across intact, and that the comparison against our
 * catalogue notices the three things worth noticing.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { readProviders } from "../tools/upstream.mjs";
import { compare } from "../tools/sync.mjs";

const dir = new URL("./fixtures/upstream/", import.meta.url);
const sources = Object.fromEntries(
  readdirSync(dir)
    .filter((file) => file.endsWith(".kt"))
    .map((file) => [file, readFileSync(new URL(file, dir), "utf8")]),
);

test("a provider's stated facts survive the crossing from Kotlin", () => {
  const providers = readProviders(sources);
  const knaben = providers.find((one) => one.id === "knaben");

  assert.equal(knaben.name, "Knaben");
  assert.equal(knaben.site, "https://knaben.org");
  assert.equal(knaben.enabled_by_default, true);
  assert.equal(knaben.cloudflare, false);
  assert.equal(knaben.unsafe, false);
  assert.equal(knaben.shape, "json");
  assert.deepEqual(knaben.capabilities.sort(), ["LatestTorrentsProvider", "TopTorrentsProvider"]);
  assert.ok(knaben.categories.includes("movies") && knaben.categories.includes("anime"));
  assert.match(knaben.source_file, /providers\/Knaben\.kt$/);
});

test("the interface itself is not a site", () => {
  const providers = readProviders(sources);
  assert.ok(!providers.some((one) => one.source_file.endsWith("SearchProvider.kt")));
});

test("`unsafe` is carried across with the reason upstream gives", () => {
  const lime = readProviders(sources).find((one) => one.id === "limetorrents");
  assert.equal(lime.unsafe, true);
  assert.equal(lime.unsafe_reason, "limetorrents_unsafe_reason");
});

test("a Cloudflare-protected site says so", () => {
  const x = readProviders(sources).find((one) => one.id === "1337x");
  assert.equal(x.cloudflare, true);
  assert.equal(x.shape, "html");
  assert.equal(x.enabled_by_default, false);
});

test("providers come back sorted, so a sync produces no spurious diff", () => {
  const ids = readProviders(sources).map((one) => one.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("the comparison notices what is missing, what moved, and what we hold alone", () => {
  const census = [
    { id: "knaben", site: "https://knaben.org", shape: "json", cloudflare: false, unsafe: false, enabled_by_default: true },
    { id: "newsite", site: "https://new.example", shape: "html", cloudflare: false, unsafe: false, enabled_by_default: false },
  ];
  const descriptors = [
    { id: "knaben", upstream: "knaben", site: "https://knaben.org", origins: ["https://api.knaben.org"] },
    { id: "moved", upstream: "newsite", site: "https://old.example", origins: ["https://old.example"] },
    { id: "gone", upstream: "retired", site: "https://x.example", origins: ["https://x.example"] },
    { id: "mine", upstream: null, site: "https://mine.example", origins: ["https://mine.example"] },
  ];

  const { missing, drifted, dropped, held } = compare(census, descriptors);
  assert.deepEqual(missing.map((one) => one.id), [], "both upstream sites are covered");
  assert.deepEqual(drifted.map((one) => one.id), ["moved"]);
  assert.equal(drifted[0].theirs, "new.example");
  assert.deepEqual(dropped.map((one) => one.id), ["gone"]);
  assert.deepEqual(held.map((one) => one.id), ["mine"]);
});

test("a host is compared without its www, so a redirect is not read as a move", () => {
  const census = [{ id: "s", site: "https://www.site.example", shape: "html", cloudflare: false, unsafe: false, enabled_by_default: false }];
  const { drifted } = compare(census, [{ id: "s", upstream: "s", site: "https://site.example", origins: ["https://site.example"] }]);
  assert.deepEqual(drifted, []);
});

test("the census this repository ships is the one the catalogue was written against", () => {
  const census = JSON.parse(readFileSync(new URL("../../upstream/providers.json", import.meta.url), "utf8"));
  assert.equal(census.providers.length, census.count);
  assert.ok(census.count >= 40, "upstream carries dozens of sites; a census this small means the reader broke");
  assert.match(census.upstream.repo, /^prajwalch\/TorrentSearch$/);
  for (const provider of census.providers) {
    assert.match(provider.id, /^[a-z0-9]+$/, `${provider.id} is not an id`);
    assert.ok(provider.site?.startsWith("https://"), `${provider.id} has no site`);
  }
});

test("the coverage report quotes the census's date, not the wall clock", () => {
  // The property the weekly job rests on: a sync that finds upstream unchanged
  // must leave the working tree exactly as it was. The census already holds
  // still, it is only rewritten when its content differs, so the one thing
  // that could churn is the date the report prints, and it has to come from
  // the census rather than from `now`.
  const census = JSON.parse(readFileSync(new URL("../../upstream/providers.json", import.meta.url), "utf8"));
  const coverage = readFileSync(new URL("../../upstream/COVERAGE.md", import.meta.url), "utf8");

  assert.ok(coverage.includes(`read ${census.synced_at}`), "COVERAGE.md should quote upstream/providers.json's synced_at");
  assert.ok(coverage.includes(census.upstream.commit), "and the commit it was read at");
});

test("the coverage report accounts for every site upstream carries", () => {
  const census = JSON.parse(readFileSync(new URL("../../upstream/providers.json", import.meta.url), "utf8"));
  const dir = new URL("../../catalogue/", import.meta.url);
  const descriptors = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(new URL(file, dir), "utf8")));

  const { missing, held } = compare(census.providers, descriptors);
  const covered = descriptors.length - held.length;
  assert.equal(missing.length + covered, census.count, "missing + covered should be every site upstream has");
});
