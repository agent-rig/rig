#!/usr/bin/env bash
# Robustly manage the Smithers workspace Gateway and its (optional) Tailscale
# exposure — one healthy Gateway on loopback, published to your tailnet over
# HTTPS so the browser UI (incl. Pending Approvals) works from any tailnet
# device with NO bearer token.
#
# Why loopback + `tailscale serve` (and not `--host <tailnet-ip> --mint-token`):
#   The Gateway's token auth is Authorization-header only. A browser navigating
#   to a URL cannot send that header, so a token-gated UI is simply unreachable
#   from a browser — no query-param, cookie, or Basic-auth fallback exists.
#   Loopback needs no token; Tailscale supplies transport auth + encryption + a
#   real HTTPS name, and the Gateway stays unauthenticated on 127.0.0.1 where
#   nothing else can reach it. `SMITHERS_GATEWAY_TRUST_ANY_HOST=1` is set so the
#   tailnet DNS name in the Host header isn't rejected as a rebinding attempt.
#
# Config (.rig/config.json "gateway" block; flags/env override, flags win):
#   gateway.port          loopback Gateway port              (default 7331)
#   gateway.mode          tailscale-serve | insecure | loopback (default: auto —
#                         tailscale-serve when Tailscale+HTTPS is available, else
#                         loopback)
#   gateway.servePort     tailscale serve HTTPS port         (default 8443)
#   gateway.trustAnyHost  accept any Host header             (default true)
#
# Usage:
#   smithers-gateway.sh [up]        Ensure the Gateway (+ serve); print the URL. Default.
#   smithers-gateway.sh down        Stop the Gateway and remove our serve mapping.
#   smithers-gateway.sh restart     down, then up.
#   smithers-gateway.sh status      Gateway + serve mapping + the reachable URL.
#   smithers-gateway.sh url         Print the console URL only (scriptable).
#   smithers-gateway.sh discover    Print what was detected about Tailscale, then exit.
#
# Options (override config):
#   --port <n>          Loopback Gateway port.
#   --serve-port <n>    Tailscale serve HTTPS port.
#   --mode <m>          tailscale-serve | insecure | loopback.
#   --no-tailscale      Loopback only; skip discovery/serve (alias: --mode loopback).
#   --insecure          Bind the tailnet IP directly with NO auth, no serve proxy
#                       (alias: --mode insecure). Exposes a full-control, unauth
#                       control plane to the whole tailnet — deliberate opt-in.
#
# Exit status: 0 on success; non-zero if the Gateway could not be made healthy.
set -euo pipefail

# --- resolve config (flags > env > .rig/config.json > default) ---------------
RIG_CONFIG="${RIG_CONFIG:-.rig/config.json}"
GW_LOG="${SMITHERS_GATEWAY_LOG:-.smithers/logs/gateway-manager.log}"

cfg() { # cfg <jq-path-under-.gateway> <default>
  local val=""
  if [[ -f "$RIG_CONFIG" ]] && command -v jq >/dev/null 2>&1; then
    val="$(jq -r ".gateway.$1 // empty" "$RIG_CONFIG" 2>/dev/null || true)"
  fi
  printf '%s' "${val:-$2}"
}

PORT="$(cfg port 7331)"
SERVE_PORT="$(cfg servePort 8443)"
MODE="$(cfg mode auto)"
TRUST="$(cfg trustAnyHost true)"

CMD="up"
[[ $# -gt 0 && "$1" != -* ]] && { CMD="$1"; shift; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --serve-port) SERVE_PORT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --no-tailscale) MODE="loopback"; shift ;;
    --insecure) MODE="insecure"; shift ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "smithers-gateway: unknown option '$1'" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*" >&2; }
die() { say "smithers-gateway: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have smithers || die "the 'smithers' CLI is not on PATH."

# --- Tailscale discovery -----------------------------------------------------
TS_UP=0 TS_IP="" TS_DNS="" TS_HTTPS=0
discover_tailscale() {
  have tailscale || return 0
  local json
  json="$(tailscale status --json 2>/dev/null || true)"
  [[ -z "$json" ]] && return 0
  if have jq; then
    [[ "$(jq -r '.BackendState // ""' <<<"$json")" == "Running" ]] && TS_UP=1
    TS_DNS="$(jq -r '.Self.DNSName // ""' <<<"$json" | sed 's/\.$//')"
    # HTTPS certs advertised == `tailscale serve` can terminate TLS for a name.
    [[ "$(jq -r '(.CertDomains // []) | length' <<<"$json")" -gt 0 ]] && TS_HTTPS=1
  fi
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
}

# --- Gateway health ----------------------------------------------------------
# Liveness is an HTTP probe of the console, NOT `smithers gateway status`: a
# manually-started or re-adopted Gateway serves fine while `status` can still
# report running:false. `gw_field` is used only for best-effort metadata.
gw_field() { # gw_field <key>  — read a field from `gateway status` (may be empty)
  smithers gateway status --format json 2>/dev/null | jq -r ".$1 // empty" 2>/dev/null || true
}
console_ok() { curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/console" 2>/dev/null; }
gw_running() { console_ok; }
gw_url() { local u; u="$(gw_field url)"; printf '%s' "${u:-http://127.0.0.1:${PORT}}"; }

wait_healthy() { # poll the loopback console until it answers (or timeout)
  local i
  for i in $(seq 1 20); do console_ok && return 0; sleep 1; done
  return 1
}

start_loopback_gateway() {
  # Idempotent: reuse a Gateway already serving the loopback console; otherwise
  # clear whatever is (or isn't) registered and start clean on loopback.
  if console_ok; then
    say "· Gateway already serving http://127.0.0.1:${PORT}"
    return 0
  fi
  smithers gateway stop >/dev/null 2>&1 || true   # clear a token-gated/stale binding
  sleep 1
  mkdir -p "$(dirname "$GW_LOG")"
  say "· starting Gateway on 127.0.0.1:${PORT} (trustAnyHost=${TRUST})…"
  local envv=()
  [[ "$TRUST" == "true" ]] && envv+=("SMITHERS_GATEWAY_TRUST_ANY_HOST=1")
  env "${envv[@]}" nohup smithers gateway --host 127.0.0.1 --port "${PORT}" \
    >>"$GW_LOG" 2>&1 &
  disown 2>/dev/null || true
  wait_healthy || die "Gateway did not become healthy on 127.0.0.1:${PORT} (see ${GW_LOG})."
  say "· Gateway healthy."
}

# --- Tailscale serve (HTTPS proxy to the loopback Gateway) --------------------
serve_target="http://127.0.0.1"   # completed with :PORT below
serve_active() { # is our https:SERVE_PORT → loopback:PORT mapping present?
  # `tailscale serve status` prints the URL and its proxy target on separate
  # lines, so match the port's stanza (header line + the following proxy line).
  tailscale serve status 2>/dev/null \
    | grep -A1 -E "://[^/[:space:]]+:${SERVE_PORT}\b" \
    | grep -qE "127\.0\.0\.1:${PORT}\b"
}
setup_serve() {
  if serve_active; then
    say "· tailscale serve already publishing :${SERVE_PORT} → 127.0.0.1:${PORT}"
    return 0
  fi
  say "· publishing over Tailscale: https :${SERVE_PORT} → 127.0.0.1:${PORT}…"
  if ! tailscale serve --bg --https="${SERVE_PORT}" "${serve_target}:${PORT}" 2>/dev/null; then
    say "  ! could not run 'tailscale serve' automatically (needs the Tailscale"
    say "    operator/root). Run this once, then re-run 'smithers-gateway.sh status':"
    say "      tailscale serve --bg --https=${SERVE_PORT} http://127.0.0.1:${PORT}"
    return 1
  fi
}
teardown_serve() {
  have tailscale || return 0
  serve_active || return 0
  say "· removing tailscale serve mapping on :${SERVE_PORT}…"
  tailscale serve --https="${SERVE_PORT}" off >/dev/null 2>&1 || \
    say "  ! could not remove it; run: tailscale serve --https=${SERVE_PORT} off"
}

console_url() {
  case "$RESOLVED_MODE" in
    tailscale-serve) printf 'https://%s:%s/console' "$TS_DNS" "$SERVE_PORT" ;;
    insecure)        printf 'http://%s:%s/console' "$TS_IP" "$PORT" ;;
    *)               printf 'http://127.0.0.1:%s/console' "$PORT" ;;
  esac
}

# --- resolve effective mode (auto -> concrete) -------------------------------
resolve_mode() {
  discover_tailscale
  case "$MODE" in
    tailscale-serve|insecure|loopback) RESOLVED_MODE="$MODE" ;;
    auto)
      if [[ "$TS_UP" == 1 && "$TS_HTTPS" == 1 && -n "$TS_DNS" ]] && have tailscale; then
        RESOLVED_MODE="tailscale-serve"
      else
        RESOLVED_MODE="loopback"
      fi ;;
    *) die "unknown mode '$MODE' (want: auto|tailscale-serve|insecure|loopback)." ;;
  esac
  # Guard modes that need Tailscale.
  if [[ "$RESOLVED_MODE" == "tailscale-serve" && ( "$TS_UP" != 1 || -z "$TS_DNS" ) ]]; then
    say "· Tailscale not ready for HTTPS serve; falling back to loopback."
    RESOLVED_MODE="loopback"
  fi
  if [[ "$RESOLVED_MODE" == "insecure" && ( -z "$TS_IP" ) ]]; then
    die "insecure mode needs a Tailscale IPv4 address, but none was found."
  fi
}

# --- commands ----------------------------------------------------------------
cmd_up() {
  resolve_mode
  case "$RESOLVED_MODE" in
    tailscale-serve)
      start_loopback_gateway
      setup_serve || true
      ;;
    insecure)
      say "· INSECURE mode: binding ${TS_IP}:${PORT} with NO auth — the control"
      say "  plane is reachable (unauthenticated) by every device on your tailnet."
      gw_running && { smithers gateway stop >/dev/null 2>&1 || true; sleep 1; }
      mkdir -p "$(dirname "$GW_LOG")"
      local envv=(); [[ "$TRUST" == "true" ]] && envv+=("SMITHERS_GATEWAY_TRUST_ANY_HOST=1")
      env "${envv[@]}" nohup smithers gateway --host "${TS_IP}" --port "${PORT}" --insecure \
        >>"$GW_LOG" 2>&1 &
      disown 2>/dev/null || true
      sleep 3
      ;;
    loopback)
      start_loopback_gateway
      say "· loopback only — reach it remotely with an SSH tunnel or 'tailscale serve'."
      ;;
  esac
  local url; url="$(console_url)"
  say ""
  say "  Smithers console: ${url}"
  say ""
  printf '%s\n' "$url"   # stdout: the URL (scriptable)
}

cmd_down() {
  resolve_mode
  teardown_serve
  say "· stopping Gateway…"
  smithers gateway stop >/dev/null 2>&1 || true
  sleep 1
  if console_ok && have lsof; then
    # stop didn't take (e.g. a detached process the singleton tracker doesn't own)
    lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
    sleep 1
  fi
  if console_ok; then
    say "  ! Gateway still reachable on 127.0.0.1:${PORT}; stop it manually."
  else
    say "· down."
  fi
}

cmd_status() {
  resolve_mode
  say "Gateway:"
  if gw_running; then
    local meta="" a p v; a="$(gw_field auth)"; p="$(gw_field pid)"; v="$(gw_field version)"
    [[ -n "$a" ]] && meta+="  auth=$a"; [[ -n "$p" ]] && meta+="  pid=$p"; [[ -n "$v" ]] && meta+="  version=$v"
    say "  running   url=$(gw_url)${meta}"
  else
    say "  stopped"
  fi
  say "Tailscale:"
  if [[ "$TS_UP" == 1 ]]; then
    say "  up  dns=${TS_DNS:-?}  ip=${TS_IP:-?}  https=$([[ $TS_HTTPS == 1 ]] && echo yes || echo no)"
    if have tailscale && serve_active; then
      say "  serve: https :${SERVE_PORT} → 127.0.0.1:${PORT} (active)"
    else
      say "  serve: (not publishing :${SERVE_PORT})"
    fi
  else
    say "  not detected"
  fi
  say "Console: $(console_url)"
}

cmd_discover() {
  discover_tailscale
  say "tailscale present : $(have tailscale && echo yes || echo no)"
  say "backend up        : $([[ $TS_UP == 1 ]] && echo yes || echo no)"
  say "dns name          : ${TS_DNS:-(none)}"
  say "ipv4              : ${TS_IP:-(none)}"
  say "https certs       : $([[ $TS_HTTPS == 1 ]] && echo yes || echo no)"
}

case "$CMD" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  restart)  cmd_down; cmd_up ;;
  status)   cmd_status ;;
  url)      resolve_mode; console_url; echo ;;
  discover) cmd_discover ;;
  *) die "unknown command '$CMD' (want: up|down|restart|status|url|discover)." ;;
esac
