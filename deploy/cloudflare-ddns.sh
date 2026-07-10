#!/usr/bin/env bash
# Dynamic DNS updater for the TimeLine home server.
#
# Keeps the Cloudflare A record for the site pointed at the box's *current*
# public IPv4 address, so the domain keeps resolving after the ISP hands the
# home connection a new IP. This is our DDNS because the router's built-in DDNS
# providers don't include Cloudflare (where the domain is registered).
#
# Run periodically by cloudflare-ddns.timer (systemd). Cheap to run often: it
# only calls Cloudflare to change the record when the IP has actually changed.
#
# Config (Cloudflare token + record name) is sourced from an env file that is
# NOT in the repo — see cloudflare-ddns.env.example. Default path:
#   /etc/timeline/cloudflare-ddns.env   (root-owned, mode 600)
set -euo pipefail

CONFIG="${1:-/etc/timeline/cloudflare-ddns.env}"
# shellcheck disable=SC1090
source "$CONFIG"
: "${CF_API_TOKEN:?set CF_API_TOKEN in $CONFIG}"
: "${CF_ZONE_NAME:?set CF_ZONE_NAME in $CONFIG}"     # e.g. your-timeline.net
: "${CF_RECORD_NAME:?set CF_RECORD_NAME in $CONFIG}"  # e.g. your-timeline.net

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

# 1. Current public IPv4. Cloudflare's own trace endpoint keeps this on
#    Cloudflare rather than trusting a random third-party "what's my IP" site.
#    Force IPv4 (-4): the box also has IPv6, and without this the trace returns
#    the IPv6 address — but we publish an A (IPv4) record and port-forward IPv4.
#    Use the www host (not the apex): it's Cloudflare-fronted and won't 301, so
#    `curl -f` (no -L) can't fail on an apex→www redirect.
current_ip=$(curl -4 -fsS https://www.cloudflare.com/cdn-cgi/trace | awk -F= '/^ip=/{print $2}')
if [[ ! "$current_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: could not determine public IPv4 (got: '${current_ip}')" >&2
  exit 1
fi

# 2. Look up the zone id for the domain (token must be scoped to this zone).
zone_id=$(curl -fsS "${api}/zones?name=${CF_ZONE_NAME}" "${auth[@]}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
if [[ -z "$zone_id" ]]; then
  echo "ERROR: zone ${CF_ZONE_NAME} not found — check the token scope." >&2
  exit 1
fi

# 3. Find the existing A record (its id + current value), if there is one.
resp=$(curl -fsS "${api}/zones/${zone_id}/dns_records?type=A&name=${CF_RECORD_NAME}" "${auth[@]}")
record_id=$(echo "$resp" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
record_ip=$(echo "$resp" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["content"] if r else "")')

# 4. Create / update / no-op. proxied=false ("DNS only", grey cloud) so the box
#    is reached directly — needed for Caddy's Let's Encrypt HTTP challenge and
#    so DNS points at the real home IP. ttl=120 = fast to propagate on a change.
if [[ -z "$record_id" ]]; then
  echo "Creating A ${CF_RECORD_NAME} -> ${current_ip}"
  curl -fsS -X POST "${api}/zones/${zone_id}/dns_records" "${auth[@]}" \
    --data "{\"type\":\"A\",\"name\":\"${CF_RECORD_NAME}\",\"content\":\"${current_ip}\",\"ttl\":120,\"proxied\":false}" >/dev/null
  echo "Created."
elif [[ "$record_ip" != "$current_ip" ]]; then
  echo "Updating A ${CF_RECORD_NAME}: ${record_ip} -> ${current_ip}"
  curl -fsS -X PATCH "${api}/zones/${zone_id}/dns_records/${record_id}" "${auth[@]}" \
    --data "{\"content\":\"${current_ip}\"}" >/dev/null
  echo "Updated."
else
  echo "No change (${CF_RECORD_NAME} already ${current_ip})."
fi
