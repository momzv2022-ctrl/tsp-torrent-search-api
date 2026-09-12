#!/bin/sh
# Put the relay behind a Cloudflare Tunnel as relay.tspsearch.dev, so no
# port is open and the server's address is never public. Run as root, once,
# after install.sh. The first step needs a browser: it prints a link, you
# open it, sign in to Cloudflare and pick the zone.
#
#     sh hosted/relay/tunnel.sh
#
# Change HOSTNAME if the front's TSP_RELAY_URL is something else.
set -eu
HOSTNAME=${HOSTNAME_OVERRIDE:-relay.tspsearch.dev}
NAME=tsp-relay

if ! command -v cloudflared >/dev/null 2>&1; then
  mkdir -p /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update && apt-get install -y cloudflared
fi

[ -f /root/.cloudflared/cert.pem ] || cloudflared tunnel login

cloudflared tunnel list 2>/dev/null | grep -q " $NAME " || cloudflared tunnel create "$NAME"
UUID=$(cloudflared tunnel list --name "$NAME" --output json | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOSTNAME"

mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<CONF
tunnel: $UUID
credentials-file: /root/.cloudflared/$UUID.json
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:8787
  - service: http_status:404
CONF

if systemctl is-enabled cloudflared >/dev/null 2>&1; then
  systemctl restart cloudflared
else
  cloudflared service install
fi
sleep 5
curl -sf "https://$HOSTNAME/api/v1/health" >/dev/null && echo "https://$HOSTNAME answers" || echo "not answering yet; give DNS a minute, then: curl https://$HOSTNAME/api/v1/health"
