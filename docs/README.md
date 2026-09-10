# tsp-torrent-search-api

A search API over public torrent indexes, in one file, run for free by
Cloudflare. It answers `GET /api/v1/search?q=…&apikey=…` in the Torrent Search
Protocol; its `/` page shows the URL and, to a request that carries the key,
the key.

If this folder is your own repository, the **Deploy to Cloudflare** button put
it there and a Worker is already running. Its URL is in your Cloudflare
dashboard under Workers & Pages. Open it and it shows you everything a client needs.

| | |
| --- | --- |
| `worker.js` | the Worker, with the catalogue compiled in as a fallback |
| `wrangler.jsonc` | what Cloudflare deploys, and under what name |
| `.dev.vars.example` | the one secret the deploy form asks for: `TSP_APIKEY` |
| `package.json` | the sentence the form shows beside it; nothing to install |
| `feed.json`, `index.html` | the project's catalogue and setup page as published on GitHub Pages, the Worker reads neither from here |

## What reaches you on its own, and what does not

The list of sites is not in the Worker. It refetches the catalogue hourly from
the project's GitHub Pages, so indexes that are fixed, added or retired reach
your deployment without you doing anything. What it falls back to when that
fetch fails is the copy compiled into `worker.js`, the `feed.json` next to it
is the same data, published for people, and nothing here reads it.

Fixes to the code itself, how a release name is read, what the front page
shows, arrive only with a new `worker.js`. Replace the file in this repository
with the current one from [the project](https://github.com/momzv2022-ctrl/tsp-torrent-search-api/blob/main/docs/worker.js)
and Cloudflare rebuilds on the push. Pasting it over the code in the
dashboard's editor works too, but only until the next push to this repository,
which deploys what is here. `/api/v1/health` reports `build`, the hash of the
code it runs, so you can tell which you have.

## Settings

Cloudflare → your Worker → Settings → Variables and Secrets. Each takes effect
on the next request, and they survive a rebuild.

| | |
| --- | --- |
| `TSP_APIKEY` | the key. Set by the deploy form; change it here |
| `TSP_SHOW_KEY` | `0` to show the key only to a request that already carries it, by default the Worker's page shows it to anyone who opens it |
| `TSP_INDEXES` | search only these, by id, comma separated; this also turns on anything switched off |
| `TSP_NSFW` | `0` to leave adult indexes out; they are searched by default |
| `TSP_BROWSE` | `0` to answer an empty query with nothing instead of browsing |
| `TSP_LIMIT` | most rows per index (default 100) |
| `TSP_TIMEOUT` | seconds to wait on one index (default 8) |
| `TSP_FEED_URL` | a catalogue of your own |
| `TSP_FEED` | `0` to pin the compiled catalogue and never refetch |

Everything else, how the catalogue is made, how to add a site, what it
searches and why, is at
[momzv2022-ctrl/tsp-torrent-search-api](https://github.com/momzv2022-ctrl/tsp-torrent-search-api).
MIT licensed. It searches public indexes and returns what they say; what you
do with a magnet link is yours to answer for.
