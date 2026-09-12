#!/bin/sh
# Install or update the relay on a Debian or Ubuntu server. Run as root from
# a clone of the repository:
#
#     cd /opt/tsp && git pull && sh hosted/relay/install.sh
#
# Wants /etc/tsp-relay.env to exist first, holding the key the front sends:
#
#     TSP_APIKEY=<the TSP_RELAY_KEY you set on the front>
#
# Puts the runtime and the Worker in /opt/tsp-relay, and (re)starts the
# service. Running it again after a pull is how the relay gets a new
# worker.js. The tunnel is tunnel.sh's job.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DIR=/opt/tsp-relay

[ -f /etc/tsp-relay.env ] || { echo "write /etc/tsp-relay.env first: TSP_APIKEY=<the front's TSP_RELAY_KEY>" >&2; exit 1; }
grep -q '^TSP_APIKEY=.\{16,\}' /etc/tsp-relay.env || { echo "/etc/tsp-relay.env needs a TSP_APIKEY= line with a real key" >&2; exit 1; }
chmod 600 /etc/tsp-relay.env

command -v node >/dev/null 2>&1 || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }

mkdir -p "$DIR"
cp "$REPO/docs/worker.js" "$DIR/worker.js"
cp "$HERE/config.capnp" "$DIR/config.capnp"
cd "$DIR"
[ -f package.json ] || npm init -y >/dev/null
npm install --no-audit --no-fund --silent workerd@latest
chmod -R a+rX "$DIR"

cp "$HERE/tsp-relay.service" /etc/systemd/system/tsp-relay.service
systemctl daemon-reload
systemctl enable --now tsp-relay >/dev/null
systemctl restart tsp-relay
sleep 2
curl -sf http://127.0.0.1:8787/api/v1/health >/dev/null && echo "relay is up on 127.0.0.1:8787" || { echo "relay did not answer; journalctl -u tsp-relay -n 50" >&2; exit 1; }
