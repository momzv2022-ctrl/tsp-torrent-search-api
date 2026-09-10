/**
 * Ask a deployed Worker which indexes still answer it.
 *
 *     npm run probe -- --worker https://your.workers.dev --key KEY
 *     npm run probe -- --worker … --key … --q "big buck bunny"
 *     npm run probe -- --worker … --key … --write     # record the verdicts
 *
 * Whether an index works is not a fact about the descriptor; it is a fact
 * about the address asking. Half these sites answer a home connection and
 * refuse a data centre's, so a laptop cannot tell you anything useful and
 * neither can this repository. Only a deployed Worker is standing where the
 * question matters, and `/api/v1/try` is how it is asked, the descriptor goes
 * over the wire and is run against the live site, whether or not it is switched
 * on in the catalogue.
 *
 * `--write` records what came back in each descriptor's `probe` field: the
 * date, the origin that answered, how many rows it read. It never flips
 * `enabled` on its own. That one is a judgement, an index can answer and
 * still be worth leaving off, as one here does by inventing results, and a
 * judgement belongs to a person and a commit message.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = join(HERE, "..", "..", "catalogue");

/** Everything a Worker needs to run one; the rest is how we maintain it. */
const BUILD_ONLY = new Set(["fixture", "note", "probe"]);
export const forWire = (descriptor) => Object.fromEntries(Object.entries(descriptor).filter(([key]) => !BUILD_ONLY.has(key)));

function catalogue() {
  return readdirSync(CATALOGUE)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, descriptor: JSON.parse(readFileSync(join(CATALOGUE, file), "utf8")) }))
    .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
}

async function try1(worker, key, descriptor, q) {
  const url = new URL("/api/v1/try", worker);
  url.searchParams.set("d", JSON.stringify(forWire(descriptor)));
  url.searchParams.set("q", q);
  url.searchParams.set("apikey", key);

  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, why: body?.error || `the Worker answered ${response.status}` };
    return { ok: body.count > 0, rows: body.count, origin: body.origin, why: (body.problems || []).join("; ") };
  } catch (error) {
    return { ok: false, why: String(error.message || error) };
  }
}

export async function probe({ worker, key, q = "ubuntu", write = false, now = new Date(), log = console.log } = {}) {
  if (!worker) throw new Error("--worker is required: the URL of a deployed Worker");

  const entries = catalogue();
  log(`asking ${worker} to try ${entries.length} descriptors with q=${JSON.stringify(q)}\n`);

  const verdicts = [];
  for (const { file, descriptor } of entries) {
    const result = await try1(worker, key, descriptor, q);
    const state = descriptor.enabled === false ? "off" : "on ";
    const verdict = result.ok ? `${String(result.rows).padStart(3)} rows  ${result.origin}` : `  -     ${result.why || "no rows"}`;
    log(`  ${state}  ${descriptor.id.padEnd(18)} ${verdict}`.slice(0, 150));
    verdicts.push({ file, descriptor, result });
  }

  const answering = verdicts.filter((one) => one.result.ok);
  const silentButOn = verdicts.filter((one) => !one.result.ok && one.descriptor.enabled !== false);
  const answeringButOff = verdicts.filter((one) => one.result.ok && one.descriptor.enabled === false);

  log(`\n${answering.length} of ${verdicts.length} answered.`);
  if (silentButOn.length) log(`switched on but silent: ${silentButOn.map((one) => one.descriptor.id).join(", ")}`);
  if (answeringButOff.length) {
    log(`switched off but answering: ${answeringButOff.map((one) => one.descriptor.id).join(", ")}`);
    log(`  read each one's note before turning it on; one of these is off for lying, not for silence.`);
  }

  if (write) {
    const at = now.toISOString().slice(0, 10);
    for (const { file, descriptor, result } of verdicts) {
      descriptor.probe = { at, answered: result.ok, ...(result.ok ? { rows: result.rows, origin: result.origin } : { why: result.why || "no rows" }) };
      writeFileSync(join(CATALOGUE, file), `${JSON.stringify(descriptor, null, 2)}\n`);
    }
    log(`\nrecorded in catalogue/*.json, commit it, and change \`enabled\` yourself where you mean to.`);
  }

  return verdicts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1];
  };
  await probe({ worker: flag("worker"), key: flag("key") || "", q: flag("q") || "ubuntu", write: argv.includes("--write") }).catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
}
