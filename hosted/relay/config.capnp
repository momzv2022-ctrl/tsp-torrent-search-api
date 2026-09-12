# The relay: this project's worker.js, run by workerd on an ordinary server.
#
# workerd is the runtime Cloudflare runs Workers on, published as a binary;
# this file tells it to serve one Worker on a local port. The Worker is the
# same docs/worker.js everyone deploys, in relay-only mode: it answers
# /api/v1/relay behind its key and /api/v1/health, and nothing else. The
# key comes from the environment (TSP_APIKEY, see tsp-relay.service), so
# this file holds no secret and can be committed.

using Workers = import "/workerd/workerd.capnp";

const config :Workers.Config = (
  services = [
    (name = "relay", worker = .relay),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "relay"),
  ],
);

const relay :Workers.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
  ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "TSP_RELAY_ONLY", text = "1"),
    (name = "TSP_APIKEY", fromEnvironment = "TSP_APIKEY"),
    (name = "TSP_SHOW_KEY", text = "0"),
  ],
  globalOutbound = "internet",
);
