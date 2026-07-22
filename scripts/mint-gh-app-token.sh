#!/usr/bin/env bash
# Mint a short-lived GitHub App installation access token and print it to stdout.
#
# Used by the auto-review-fix workflow to push the fix commit AS the App
# (not the default GITHUB_TOKEN) so downstream checks re-run normally. Kept as a
# standalone, project-agnostic script — no repo, app, or org values are baked in;
# everything comes from env.
#
# Required env:
#   APP_ID           — the GitHub App's numeric ID
#   APP_PRIVATE_KEY  — the App private key, raw PEM or base64-encoded PEM
#   INSTALLATION_ID  — the App installation ID on the target org/repo
#
# On success prints ONLY the token to stdout (so callers can `TOKEN=$(...)`).
# Exits non-zero with a stderr message on any failure.
#
# Requires: openssl, curl, jq, base64 (all present on GitHub-hosted runners).
set -euo pipefail

: "${APP_ID:?APP_ID is required}"
: "${APP_PRIVATE_KEY:?APP_PRIVATE_KEY is required}"
: "${INSTALLATION_ID:?INSTALLATION_ID is required}"

pem_file=$(mktemp)
# Remove the key even if a later command aborts under `set -e`.
trap 'rm -f "$pem_file"' EXIT

# Accept the key as raw PEM or base64-encoded PEM.
if printf '%s' "$APP_PRIVATE_KEY" | grep -q '^-----'; then
  printf '%s' "$APP_PRIVATE_KEY" > "$pem_file"
else
  printf '%s' "$APP_PRIVATE_KEY" | base64 -d > "$pem_file"
fi

b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }

now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
# iat back-dated 60s for clock skew; exp at the 10-min max GitHub allows.
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$APP_ID" | b64url)
sig=$(printf '%s' "${header}.${payload}" | openssl dgst -sha256 -sign "$pem_file" | b64url)
jwt="${header}.${payload}.${sig}"

token=$(curl --silent --fail-with-body -X POST \
  -H "Authorization: Bearer $jwt" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens" | jq -r .token)

[ -n "$token" ] && [ "$token" != "null" ] || { echo "failed to mint GitHub App token (check APP_ID / INSTALLATION_ID / key)" >&2; exit 1; }
printf '%s' "$token"
