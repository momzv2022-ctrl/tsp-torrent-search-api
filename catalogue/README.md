# The catalogue

One JSON file per index. Nothing here is code, and nothing in the Worker knows
the name of a single site; that is the point. To add a site you add a file; to
fix one you edit a file. Nobody re-pastes a Worker, because every deployment
refetches this list hourly.

## What to add next

`npm run sync` reads [prajwalch/TorrentSearch][upstream] and writes
[`../upstream/COVERAGE.md`](../upstream/COVERAGE.md), which lists every site
upstream carries that we do not. That is the queue. It also flags a site whose
address has moved under us, and one upstream has dropped.

It does **not** write descriptors. Upstream parses each site with a hand-written
Kotlin class, and turning one into a descriptor is a judgement about how a page
is laid out; a regular expression claiming to do that would be lying. So the
sync tells you what to write; you write it.

## Writing one

```jsonc
{
  "id": "example",                       // lowercase, unique, permanent
  "upstream": "exampleid",               // the id in upstream/providers.json, or null if ours alone
  "name": "Example",
  "site": "https://example.com",         // the site a person would visit
  "kind": "json",                        // json | rss | html
  "fixture": "example.json",             // a recorded answer, in ../worker/tests/fixtures/
  "enabled": true,                       // off by default? say why in "note"
  "match": "name",                       // only for a site that ignores the query: keep rows whose name has every word
  "origins": ["https://api.example.com"],// where to actually ask; mirrors in order
  "categories": ["movies", "series"],    // from upstream's census
  "request": { "method": "GET", "path": "/search", "query": { "q": "{q}" } },
  "rows": "results",                     // where the rows are
  "fields": { "name": "title", "infohash": "hash", "seeders": "seeders" }
}
```

`{q}` is the query and `{limit}` the row cap; `{q+}` joins words with `+` for
sites that want that in a path.

### Where the rows are

| kind   | `rows`                                          |
| ------ | ----------------------------------------------- |
| `json` | a dotted path: `hits`, `""` for a bare array, `data.movies[].torrents[]` to iterate nested arrays |
| `rss`  | omitted for a normal feed; otherwise a path like `rss/channel/item` |
| `html` | a CSS selector for the row elements: `table#results tr` |

### Where the fields are

A field is a path, a list of paths tried in order, or an object:

| form | means |
| ---- | ----- |
| `"title"` | the value at that path |
| `["hash", "magnetUrl"]` | the first that yields anything |
| `{ "sel": "td.n a", "attr": "href" }` | HTML: an attribute rather than the text |
| `{ "cell": -2 }` | HTML: a cell by position, for tables with no classes |
| `{ "from": "size", "nonzero": true }` | `0` here means "not recorded" |
| `{ "from": "id", "template": "https://…/{value}" }` | build a URL around it |
| `{ "from": "cat", "prefix": 1, "map": { "1": "video" } }` | classify by leading digits |
| `{ "from": "link", "re": "([a-f0-9]{40})" }` | pull it out with a pattern |
| `{ "const": "video" }` | a site that only ever carries one thing |

In JSON, a row produced by a `[]` step can reach the object it came out of as
`^`: `"^.title_long"` is how a YTS torrent finds the film's name.

The fields you may fill: `name`, `infohash`, `magnet`, `size_bytes`, `seeders`,
`leechers`, `files`, `category`, `first_seen`, `description_url`, `torrent_url`.
`name` is required, and so is one of `infohash` or `magnet`, a row that cannot
be turned into a magnet link is not a result. Everything else is optional, and
sizes, dates and counts are read in whatever shape the site prints them
(`1.5 GiB`, `2 days ago`, `Jan 5, 2024`, epoch seconds).

`category` must be one of `video`, `audio`, `software`, `archive`, `document`,
`image`, `other`. A site with exactly one entry in `categories` fills it in for
free.

## Trying it before you commit

Deploy the Worker, then ask it to run your candidate against the live site:

```bash
curl -sG "$WORKER/api/v1/try" --data-urlencode "d=$(cat catalogue/example.json)" \
  --data-urlencode "q=ubuntu" --data-urlencode "apikey=$KEY"
```

It answers with the rows your descriptor produced, the origin that worked, and
every origin that did not. Do this from a deployed Worker rather than your
laptop: a good half of these sites answer a home address and refuse a data
centre's, and the Worker is the only thing that can tell you which.

## Recording a fixture

Every descriptor needs one, and `npm test` refuses a descriptor that no longer
reads its own. Save the site's raw answer into `../worker/tests/fixtures/`,
name it in `"fixture"`, and trim it to a handful of rows, it is there to catch
a selector rotting, not to be a copy of the site.

```bash
npm test          # validates, replays every fixture, checks docs/ is current
npm run build     # regenerates docs/
```

Then commit the descriptor, the fixture and `docs/`.

## Turning one off

Set `"enabled": false` and put the reason in `"note"`. A site that refuses
Cloudflare's addresses, or answers with results it invented, is worth keeping
described and switched off, the note is what stops the next person rediscovering
it. Anyone can still turn it on with `TSP_INDEXES`.

[upstream]: https://github.com/prajwalch/TorrentSearch
