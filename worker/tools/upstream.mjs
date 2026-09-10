/**
 * Reading prajwalch/TorrentSearch.
 *
 * Upstream keeps one Kotlin class per site, and the facts we need are written
 * at the top of each as plain `override val` lines, id, name, url, which
 * categories the site answers for, whether it is safe, whether it is on by
 * default, whether Cloudflare stands in front of it. Those lines are data
 * wearing a language's clothes, and this file undresses them.
 *
 * What it deliberately does not do is read the parsing below. That part is a
 * program, Jsoup selectors, hand-rolled date maths, per-site special cases,
 * and a regular expression that claimed to understand it would be lying. The
 * descriptors in `catalogue/` are where that knowledge lives, written once per
 * site and checked against a recorded response.
 *
 * So this is a census, not a translation: it tells you every site upstream
 * knows about and everything upstream states outright about it, which is
 * exactly what is needed to notice that a site was added, moved, or dropped.
 */

const OWNER = "prajwalch";
const REPO = "TorrentSearch";
const PROVIDER_DIR = "app/src/main/kotlin/com/prajwalch/torrentsearch/providers";

/** Classes in the provider folder that are not sites. */
const NOT_A_SITE = new Set(["SearchProvider.kt", "TorznabSearchProvider.kt"]);

export const UPSTREAM = { owner: OWNER, repo: REPO, dir: PROVIDER_DIR, url: `https://github.com/${OWNER}/${REPO}` };

/** `override val <name> = "<text>"`, first occurrence. */
function stringVal(source, name) {
  const found = source.match(new RegExp(`override\\s+val\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]*)"`));
  return found ? found[1] : null;
}

/** `override val <name> = true|false`, first occurrence. */
function boolVal(source, name, fallback = false) {
  const found = source.match(new RegExp(`override\\s+val\\s+${name}\\s*(?::[^=]+)?=\\s*(true|false)`));
  return found ? found[1] === "true" : fallback;
}

/**
 * The categories a site answers for, as upstream's enum names, lowercased.
 *
 * Written as `setOf(Category.Movies, Category.Series, ...)`, sometimes over
 * several lines, sometimes `emptySet()`, sometimes absent, the interface
 * defaults it to empty, which upstream reads as "no category filter", not "no
 * results".
 */
function categories(source) {
  const found = source.match(/override\s+val\s+supportedCategories\s*(?::[^=]+)?=\s*setOf\(([\s\S]*?)\)/);
  if (!found) return [];
  return [...found[1].matchAll(/Category\.(\w+)/g)].map((m) => m[1].toLowerCase());
}

/**
 * Whether upstream calls the site unsafe, and the reason string resource it
 * names. `Unsafe` is upstream's word for "this site carries malware bait or
 * deceptive download buttons", not a judgement about its content.
 */
function safety(source) {
  const found = source.match(/override\s+val\s+safetyStatus\s*(?::[^=]+)?=\s*SearchProviderSafetyStatus\.(\w+)/);
  const status = found ? found[1] : "Safe";
  if (status !== "Unsafe") return { unsafe: false, reason: null };
  const reason = source.match(/SearchProviderSafetyStatus\.Unsafe\(\s*(?:reason\s*=\s*)?R\.string\.(\w+)/);
  return { unsafe: true, reason: reason ? reason[1] : null };
}

/** The optional interfaces the class implements, beyond plain search. */
function capabilities(source) {
  const names = ["LatestTorrentsProvider", "TopTorrentsProvider", "TorrentDetailsProvider", "MagnetUriProvider"];
  return names.filter((name) => new RegExp(`(?:^|[,:\\s])${name}\\b`, "m").test(source.split("{")[0] || source));
}

/**
 * How the site answers, as far as the imports and calls admit: `json` when the
 * class only ever asks for JSON, `html` when it hands the body to Jsoup, and
 * `mixed` when it does both (a search page scraped for links, then an API for
 * the rest). This is a hint for whoever writes the descriptor, not a promise.
 */
function shape(source) {
  const json = /networkClient\.(?:getJson|postJson)/.test(source);
  const scraped = /Jsoup/.test(source) || /networkClient\.getText/.test(source);
  if (json && scraped) return "mixed";
  if (json) return "json";
  return "html";
}

/** Every fact upstream states outright about one site. */
export function readProvider(file, source) {
  const id = stringVal(source, "id");
  if (!id) return null;
  const { unsafe, reason } = safety(source);
  return {
    id,
    name: stringVal(source, "name") || id,
    site: stringVal(source, "url") || null,
    categories: categories(source),
    enabled_by_default: boolVal(source, "enabledByDefault"),
    cloudflare: boolVal(source, "isCloudflareProtected"),
    unsafe,
    unsafe_reason: reason,
    capabilities: capabilities(source),
    shape: shape(source),
    source_file: `${PROVIDER_DIR}/${file}`,
  };
}

/** Read a checkout of upstream: `{ file: source }` in, census out, sorted by id. */
export function readProviders(sources) {
  return Object.entries(sources)
    .filter(([file]) => file.endsWith(".kt") && !NOT_A_SITE.has(file))
    .map(([file, source]) => readProvider(file, source))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function json(url) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": `${OWNER}-${REPO}-sync` } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * Fetch upstream's provider folder at `ref`.
 *
 * Two calls to the API, the commit, then the tree, and then the files
 * themselves from raw.githubusercontent.com, which is not rate limited. That
 * matters: unauthenticated GitHub allows sixty API calls an hour, and one file
 * per site would spend most of them on a single sync.
 */
export async function fetchProviders(ref = "main") {
  const commit = await json(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${ref}`);
  const sha = commit.sha;
  const tree = await json(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${sha}?recursive=1`);

  const files = tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(`${PROVIDER_DIR}/`) && entry.path.endsWith(".kt"))
    .map((entry) => entry.path);
  if (!files.length) throw new Error(`no provider sources under ${PROVIDER_DIR} at ${sha}`);

  const sources = {};
  await Promise.all(
    files.map(async (path) => {
      const response = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${path}`);
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      sources[path.slice(PROVIDER_DIR.length + 1)] = await response.text();
    }),
  );

  return { sha, committed_at: commit.commit?.committer?.date || null, sources };
}
