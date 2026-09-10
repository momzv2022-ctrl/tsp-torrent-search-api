# tsp-torrent-search-api

A search API over public torrent indexes, in one file, run for free by
Cloudflare. As a Worker it answers `GET /api/v1/search?q=…` in TSP, the
Torrent Search Protocol. Its `/` page shows you the URL and the key.

**[Set it up →][page]**

## The idea

The list of sites is not in the Worker.

```
prajwalch/TorrentSearch          43 sites, maintained by people who
        │                        follow these things for a living
        │  npm run sync
        ▼
upstream/providers.json          a census: every site, and every fact
        │                        upstream states outright about it
        │  written by hand, once per site
        ▼
catalogue/*.json                 descriptors: where to ask, how to ask,
        │                        which field feeds which
        │  npm run build
        ▼
docs/feed.json                   published on GitHub Pages
        │
        │  refetched hourly by every deployment
        ▼
your Worker                      which holds no opinion about what to search
```

The previous attempt at this ran the arrow the other way: its feed was
generated *from* a list inside the Worker. That made the catalogue only ever as
large as what someone had typed into a source file, and a deployed Worker a
photograph of the day it was pasted. Both problems have the same fix: make the
catalogue data, and put a project that tracks these sites upstream of it.

So: a site upstream adds turns up in [`upstream/COVERAGE.md`](upstream/COVERAGE.md)
as missing. A site that moves turns up as drifted. Adding one is a JSON file.
And a Worker that has been up an hour is searching whatever the feed says, not
whatever was true when it was pasted. The copy compiled into the file is only
what it falls back to when the feed cannot be reached.

## Use it

```
GET /api/v1/search?q=ubuntu&apikey=…
```

| | |
| --- | --- |
| `q` | the query. `.`, `_` and `-` are separators |
| `limit`, `offset` | page through the merged rows (default 50) |
| `cat` | `video`, `audio`, `software`, `archive`, `document`, `image`, `other` |
| `min_seeders` | drop anything under |
| `indexers` | ask only these, by id |

The key goes in `?apikey=`, `X-Api-Key:` or `Authorization: Bearer`.

An empty `q` means "browse" in TSP, and a metasearch has no index of its own to
browse, so it asks every index for a common technical marker instead, chosen
for the `cat` you gave and rotated hourly. The term comes back as
`browse_query`. Without this, the one or two indexes that happen to answer an
empty query account for the whole result. `TSP_BROWSE=0` keeps the strict
reading: an empty query, an empty answer.

```json
{
  "query": "ubuntu",
  "count": 87,
  "limit": 50,
  "offset": 0,
  "took_ms": 940,
  "torrents": [
    {
      "name": "ubuntu-24.04.2-desktop-amd64.iso",
      "infohash": "611f70899d…",
      "magnet": "magnet:?xt=urn:btih:611f70899d…",
      "size_bytes": 6343219200,
      "seeders": 165,
      "leechers": 12,
      "category": "software",
      "first_seen": "2026-02-20T00:00:00.000Z",
      "scraped_at": "2026-09-09T11:04:22.140Z",
      "sources": ["knaben", "piratebay"]
    }
  ],
  "engines": ["knaben", "piratebay", "torrentscsv"]
}
```

The same release from three indexes is one row that names all three. An index
that fails is listed under `failures` and does not fail the search.

| route | |
| --- | --- |
| `/` | this deployment's URL, index list and key; the key to anyone unless `TSP_SHOW_KEY=0` limits it to a request that already carries it |
| `/api/v1/search` | the search |
| `/api/v1/indexers` | what it can search, and what is on |
| `/api/v1/health` | which catalogue and which build it is running, no key needed |
| `/api/v1/try?d=…` | run a descriptor that is not in the catalogue yet |

## Settings

Cloudflare → your Worker → Settings → Variables and Secrets. Each takes effect
on the next request, and they survive a rebuild.

| | |
| --- | --- |
| `TSP_APIKEY` | the key. The deploy form sets it; a pasted file has it baked in; this overrides either |
| `TSP_SHOW_KEY` | `0` to show the key only to a request that already carries it; by default the `/` page shows it to anyone who opens it |
| `TSP_INDEXES` | search only these, by id, comma separated; this also turns on anything switched off |
| `TSP_NSFW` | `0` to leave adult indexes out; they are searched by default |
| `TSP_BROWSE` | `0` to answer an empty query with nothing instead of browsing |
| `TSP_LIMIT` | most rows per index (default 100) |
| `TSP_TIMEOUT` | seconds to wait on one index (default 8) |
| `TSP_FEED_URL` | a catalogue of your own |
| `TSP_FEED` | `0` to pin the compiled catalogue and never refetch |

## Working on it

No dependencies, no install step, no lockfile. Node 20 or newer.

```bash
npm run sync     # read upstream, rewrite the census and COVERAGE.md
npm run build    # regenerate docs/ from catalogue/
npm test         # validate, replay every fixture, check docs/ is current
npm run probe -- --worker https://your.workers.dev --key KEY
```

- **Add or fix an index**: [`catalogue/README.md`](catalogue/README.md). One
  JSON file, one recorded fixture, `npm run build`, commit.
- **See what is missing**: [`upstream/COVERAGE.md`](upstream/COVERAGE.md),
  rewritten by every sync.
- **See what still answers**: `npm run probe`. Whether an index works is a
  fact about the address asking, not about the descriptor: half these sites
  answer a home connection and refuse a data centre's, so only a deployed
  Worker can tell you. `--write` records each verdict; it never flips `enabled`
  on its own, because an index can answer and still be worth leaving off.

`npm run sync` is the half that belongs on a clock, and it is on one:
[`.github/workflows/sync.yml`](.github/workflows/sync.yml) runs it weekly,
rebuilds `docs/`, runs the tests, and commits, but only if any of that actually
changed. A week in which upstream added nothing produces no commit, because a
sync that finds nothing new writes nothing new. Nobody has to run anything.

Every push and pull request runs `npm test`
([`test.yml`](.github/workflows/test.yml)), so a descriptor that has stopped
reading its own recorded response cannot reach the feed.

Most fixes travel in the feed and reach every deployment within the hour: a
descriptor's selectors, its origins, whether it is on. Some live in the code
(how a release name is read, how a field is coerced), and those only arrive with
a new `worker.js`, pasted or pushed. `/api/v1/health` reports `build` (the
first twelve hex of `worker/src/worker.js`'s SHA-256) so you can tell which of
the two a deployment is running before wondering why a fix has not landed. `npm
run build` prints the same string; if they differ, the deployment is running
older code and wants a fresh file.

`docs/` is committed rather than built by CI, because GitHub Pages will serve a
branch's `/docs` with no workflow at all: Settings → Pages → "Deploy from a
branch" → `main` → `/docs`. `docs/worker.js` is the source with one array
filled in, so the SHA-256 the page publishes is the hash of a file you can read.

The page's one-click route is the Workers Playground's Deploy button, built
here instead of there: the Worker with the key in it, as multipart form data,
lz-string-compressed into the fragment of a `dash.cloudflare.com/…/deploy/
playground/` URL, the format `packages/workers-playground` in
cloudflare/workers-sdk writes and the dashboard reads. It needs a Cloudflare
login and nothing else. The fragment never reaches a server; the compressor is
inlined in the page because the page has no dependencies to fetch.

`docs/` also works as the target of Cloudflare's Deploy to Cloudflare button,
which copies the folder into a repository of the person's own and rebuilds on
every push. The page does not offer it, because it needs a GitHub or GitLab
account as well, but the files are there for anyone who wants that:
`wrangler.jsonc` says what to deploy and sets `keep_vars` so a rebuild keeps
the dashboard's settings; `.dev.vars.example` makes the form ask for
`TSP_APIKEY`, and ships that line empty because the form pre-fills whatever
follows the `=`; `package.json` carries the sentence the form shows beside it;
`README.md` is what the copy shows its owner. `npm test` checks them, and that
no `.env.example`, which the form reads the same way, has appeared beside them.

## What it searches

Everything in `catalogue/` that is switched on, which includes an adult index
(sukebei). The catalogue records `nsfw` per index and `/api/v1/indexers`
reports it, so a caller can filter; the Worker does not filter for you.
`TSP_NSFW=0` leaves them out.

The default is deliberate. Whoever deploys this chose to, and it is their
search API; a default that quietly withheld part of the catalogue would be
this project deciding something that is not its to decide.

## What this is not

It does not host, store, index or seed anything. It asks public search pages
the question you gave it and hands back what they said, in one shape instead of
forty. What you do with a magnet link is yours to answer for.

## Credits

The sites come from prajwalch/TorrentSearch (MIT), an Android app
that has done the actual work of finding out which of these places are alive
and how to read them. This project reads its provider list; the descriptors are
written against the same sites. MIT licensed.

[page]: https://momzv2022-ctrl.github.io/tsp-torrent-search-api/
