#!/usr/bin/env bash
# Set the display name for the current background-job session.
#
# CLAUDE CODE ONLY. Writes the `name` field in $CLAUDE_JOB_DIR/state.json
# (atomic tmp+mv) so a background job shows up in the job list as the work it's
# doing (the ticket / epic) instead of the raw prompt that started it. No-op
# anywhere without a FleetView background job (state.json absent) or without jq
# — so it's harmless to call from any agent; it simply does nothing off Claude.
#
# Usage:
#   set-session-name.sh "EPIC: Auth rewrite (ABC-712)"
#   set-session-name.sh "FEAT: Rename creation modes (ABC-521)"
#   set-session-name.sh "CHORE: Bump deps (ABC-733)"
#   set-session-name.sh "FEAT: ... (ABC-521)" --skip-if-prefix "EPIC:"
#
# --skip-if-prefix <prefix>  Leave the existing name in place if it already
#                            starts with <prefix>. Use when rig-task runs as a
#                            child of rig-epic — the EPIC: label should win over
#                            the per-child FEAT/CHORE label.
#
# Skills invoke this once they know the ticket they're working on. Safe to
# re-run — the field is overwritten in place.
set -euo pipefail

NAME=""
SKIP_PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-if-prefix) SKIP_PREFIX="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "set-session-name: unknown flag $1" >&2; exit 2 ;;
    *)
      if [ -z "$NAME" ]; then NAME="$1"; else
        echo "set-session-name: too many positional args" >&2; exit 2
      fi
      shift ;;
  esac
done

if [ -z "$NAME" ]; then
  echo "usage: $0 <name> [--skip-if-prefix <prefix>]" >&2
  exit 2
fi

# Off Claude Code / not a background job → nothing to name.
if [ -z "${CLAUDE_JOB_DIR:-}" ] || [ ! -f "$CLAUDE_JOB_DIR/state.json" ]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "set-session-name: jq not found; skipping" >&2
  exit 0
fi

if [ -n "$SKIP_PREFIX" ]; then
  current=$(jq -r '.name // ""' "$CLAUDE_JOB_DIR/state.json")
  case "$current" in
    "$SKIP_PREFIX"*) exit 0 ;;
  esac
fi

tmp=$(mktemp)
jq --arg n "$NAME" '.name = $n' "$CLAUDE_JOB_DIR/state.json" > "$tmp"
mv "$tmp" "$CLAUDE_JOB_DIR/state.json"
