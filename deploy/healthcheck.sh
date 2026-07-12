#!/usr/bin/env bash
# On-box uptime check for the TimeLine home server (Phase 7).
#
# healthchecks.io (which we already use for backups) is a PASSIVE, dead-man's-
# switch service: it can't reach out and probe your site itself. So this script
# is the active half — it runs on the box every few minutes (timeline-
# healthcheck.timer), curls the app's health endpoint, and reports the result to
# a healthchecks.io check by pinging it:
#
#   - site answers 200  -> ping the check's SUCCESS url  (all is well)
#   - site answers badly -> ping the check's /fail url    (immediate alert)
#   - box off / internet down -> the timer can't run, so NO ping arrives, and
#     healthchecks.io alerts once the expected ping is overdue (that's the whole
#     point of a dead-man's switch: silence itself is the alarm).
#
# Between them those three cover every realistic home-server outage: power loss,
# a crashed box, a crashed container, a dead database, or the home broadband
# dropping. The health endpoint runs a `SELECT 1`, so "gunicorn up but Postgres
# down" is caught too.
#
# WHERE IT PROBES. By default it hits the PUBLIC hostname but pinned to loopback
# (RESOLVE below), so it exercises the real serving stack — Caddy's TLS cert,
# routing, gunicorn, the DB — without depending on the home router being able to
# "hairpin" a request back to itself (many can't, which would cause false
# alarms). The trade-off: it does NOT test the inbound path from the wider
# internet (port forwarding, public DNS). Those rarely break once set and stay
# fixed; if you want to cover them too, add a second, off-box monitor later.
#
# Run by timeline-healthcheck.timer (systemd), every few minutes, as the deploy
# user. Config is sourced from an env file outside the repo:
#   Default config path: /etc/timeline/healthcheck.env
#
# Manual run (prints what it did and why):
#   ./deploy/healthcheck.sh
set -euo pipefail

CONFIG="${1:-/etc/timeline/healthcheck.env}"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config $CONFIG not found. Copy deploy/healthcheck.env.example to it." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

# --- config with sensible defaults -----------------------------------------
# The health endpoint to probe. Public hostname so we test the real TLS + routing.
TARGET_URL="${TARGET_URL:-https://your-timeline.net/api/healthz/}"
# The healthchecks.io ping URL for THIS check (e.g. https://hc-ping.com/<uuid>).
: "${PING_URL:?set PING_URL in $CONFIG (the healthchecks.io ping URL for the uptime check)}"
# Optional curl --resolve override "host:port:addr" so the public hostname is
# connected to loopback (sidesteps router hairpinning). Blank = normal DNS.
RESOLVE="${RESOLVE:-your-timeline.net:443:127.0.0.1}"
# How long to wait for the site before calling it down.
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"
# How long to wait when pinging healthchecks.io (never let it hang the timer).
PING_MAX_TIME="${PING_MAX_TIME:-10}"

resolve_args=()
if [[ -n "$RESOLVE" ]]; then
  resolve_args=(--resolve "$RESOLVE")
fi

# Probe the site. -sS keeps it quiet but still prints real errors; we read the
# HTTP status code rather than relying on curl's exit code so a 503 (DB down) is
# treated as "unhealthy", not "unreachable". A connection failure yields "000".
# On a connection failure curl already emits "000" via -w and exits non-zero;
# `|| true` keeps that "000" without set -e aborting (and without doubling it).
code="$(curl -sS -o /dev/null -w '%{http_code}' \
  -m "$CURL_MAX_TIME" "${resolve_args[@]}" "$TARGET_URL" 2>/dev/null || true)"

if [[ "$code" == "200" ]]; then
  # Healthy — tell healthchecks.io we're alive. A failure to REACH it (e.g. the
  # home internet is down) must not mask the real state: we simply don't ping,
  # so the check goes overdue and alerts, which is the correct outcome.
  if ! curl -fsS -m "$PING_MAX_TIME" "$PING_URL" >/dev/null 2>&1; then
    echo "WARN: site OK but could not reach healthchecks.io to report success" >&2
  fi
  echo "OK: $TARGET_URL -> 200; success ping sent."
else
  # Unhealthy — hit the /fail endpoint for an IMMEDIATE alert (don't wait for the
  # ping to merely go overdue). Still best-effort: no internet => no ping => the
  # overdue alert covers it anyway.
  echo "UNHEALTHY: $TARGET_URL -> HTTP $code" >&2
  if ! curl -fsS -m "$PING_MAX_TIME" "${PING_URL%/}/fail" >/dev/null 2>&1; then
    echo "WARN: could not reach healthchecks.io to report the failure" >&2
  fi
  # Exit non-zero so the failure is also visible locally in `systemctl status`
  # / the journal, not only on healthchecks.io.
  exit 1
fi
