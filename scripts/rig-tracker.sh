#!/usr/bin/env bash
# rig-tracker — project-overridable tracker/board adapter (rig's default impl).
#
# This is the ONE sanctioned fork point for tracker/board behavior (see #38).
# Everything else in rig is config-over-forking; the tracker's *policy* (how you
# select dispatchable work, how you move a board) is open-ended, so it lives in
# code here rather than an ever-growing config schema. A project that outgrows
# this default drops its own executable at `.rig/rig-tracker` and rig calls that
# instead — this file is never edited in-place by a consumer, so rig can keep
# updating it on re-sync without clobbering local policy.
#
# CONTRACT
#   rig-tracker <verb> [flags]
#   - JSON to stdout (so an LLM skill and a smithers/TS workflow parse the same
#     thing), human logs to stderr, exit code = success/failure.
#
# RESOLVER (callers use this, not this path directly):
#   TRACKER="$( [ -x .rig/rig-tracker ] && echo .rig/rig-tracker \
#               || echo "$RIG_DIR/scripts/rig-tracker.sh" )"
#   "$TRACKER" select --status Todo --dispatchable
#
# VERBS
#   select [--status <name>] [--label <name>]... [--dispatchable] [--limit <N>]
#        List issues matching a query. --status filters by the Project *board*
#        column (ProjectV2); --label filters by issue label; --dispatchable is
#        the default policy "status == board.statusOptions.todo AND label ∈
#        tracker.shapeLabels". Emits [{id,number,title,url,status,labels,blockedBy}].
#   next  Shorthand for `select --dispatchable --limit 1` — the next unit an
#        autonomous loop should pick up.
#   link-pr <issue#> <pr#>
#        Ensure the PR closes/links the issue (default: a "<closingKeyword> #N"
#        line in the PR body → GitHub links it and moves the board on merge).
#   set-status <issue#> <status-name>
#        Move the issue's board item to <status-name> (ProjectV2 item-edit).
#   add-to-project <issue#>
#        Add the issue to the configured Project board.
#
# CONFIG (.rig/config.json — identity only; policy lives in this script):
#   tracker.provider                "github" | "linear" | "none"
#   tracker.board.owner             GitHub org/user that owns the Project (e.g. "agent-rig")
#   tracker.board.projectNumber     ProjectV2 number (the N in /projects/N)
#   tracker.board.statusField       Single-select field name (default "Status")
#   tracker.board.statusOptions     { todo, inProgress, inReview, done } → display names on the board
#   tracker.board.closingKeyword    PR-body closing keyword (default "Closes")
#   tracker.shapeLabels             { epic, sprint, ... } → used by --dispatchable
#
# NOTE ON PROVIDERS: this default implements `github` (via `gh` + ProjectV2) and
# `none` (degrades to empty/no-op). `linear` is intentionally NOT implemented
# here — the shell has no Linear CLI; a Linear project supplies its own
# `.rig/rig-tracker` (curl + LINEAR_API_KEY) or drives Linear via the agent's MCP
# tools. This keeps the default runtime-agnostic and gh-only.
#
# TESTABILITY: `gh` and `jq` are overridable via RIG_TRACKER_GH / RIG_TRACKER_JQ,
# and the config path via RIG_CONFIG, so the script can be exercised with mocks.
set -euo pipefail

GH="${RIG_TRACKER_GH:-gh}"
JQ="${RIG_TRACKER_JQ:-jq}"

# Candidate scan depth: how many rows to pull from each source (label queries and
# the board column) BEFORE intersecting — deliberately independent of the result
# --limit, so a small --limit (e.g. next's 1) can't truncate a source below the
# overlap (see #66). Overridable for huge boards / tests.
SCAN_DEPTH="${RIG_TRACKER_SCAN:-500}"

die()  { echo "rig-tracker: $*" >&2; exit 1; }
warn() { echo "rig-tracker: $*" >&2; }

# ---- config -----------------------------------------------------------------
# Locate .rig/config.json: explicit RIG_CONFIG, else walk up from CWD.
find_config() {
  if [ -n "${RIG_CONFIG:-}" ]; then echo "$RIG_CONFIG"; return; fi
  local d; d="$(pwd)"
  while [ "$d" != "/" ]; do
    [ -f "$d/.rig/config.json" ] && { echo "$d/.rig/config.json"; return; }
    d="$(dirname "$d")"
  done
  echo ""  # none found — provider defaults to "none"
}
CONFIG="$(find_config)"

# cfg <jq-filter> [default] — read a value from config, or the default if absent.
cfg() {
  local filter="$1" def="${2:-}"
  [ -f "$CONFIG" ] || { echo "$def"; return; }
  local v; v="$("$JQ" -r "$filter // empty" "$CONFIG" 2>/dev/null || true)"
  [ -n "$v" ] && echo "$v" || echo "$def"
}

PROVIDER="$(cfg '.tracker.provider' none)"
B_OWNER="$(cfg '.tracker.board.owner')"
B_NUM="$(cfg '.tracker.board.projectNumber')"
B_FIELD="$(cfg '.tracker.board.statusField' Status)"
CLOSING_KW="$(cfg '.tracker.board.closingKeyword' Closes)"

status_display() { # logical (todo|inProgress|inReview|done) -> board display name
  cfg ".tracker.board.statusOptions.$1"
}
shape_label_values() { # -> newline-separated shapeLabels values
  [ -f "$CONFIG" ] || return 0
  "$JQ" -r '.tracker.shapeLabels // {} | to_entries[] | .value' "$CONFIG" 2>/dev/null || true
}

require_board() {
  [ -n "$B_OWNER" ] && [ -n "$B_NUM" ] || die \
    "this operation needs a Project board — set tracker.board.owner and tracker.board.projectNumber in $CONFIG"
}

# ---- github helpers ---------------------------------------------------------
# Issues matching label filters (has labels), as contract JSON. $@ = labels (OR).
gh_issues_by_labels() {
  local limit="$1"; shift
  local args=(issue list --state open --limit "$limit" --json number,title,url,labels,state)
  if [ "$#" -eq 0 ]; then
    "$GH" "${args[@]}" | contract_from_issue_json
  else
    # OR across labels: union per-label results by number.
    local l acc="[]"
    for l in "$@"; do
      local part; part="$("$GH" "${args[@]}" --label "$l")"
      acc="$("$JQ" -c --argjson a "$acc" --argjson b "$(echo "$part" | contract_from_issue_json)" \
        -n '$a + $b | unique_by(.number)')"
    done
    echo "$acc"
  fi
}

# Map `gh issue list --json ...` output to the contract shape (stdin -> stdout).
contract_from_issue_json() {
  "$JQ" -c '[ .[] | {
    id: (.number|tostring), number, title, url,
    status: null,
    labels: [ .labels[]?.name ],
    blockedBy: []
  } ]'
}

# Issue numbers on the board with a given Status display name (ProjectV2).
gh_issue_numbers_by_status() {
  local status="$1" limit="$2"
  require_board
  # gh flattens a single-select field to a lowercased key of its title.
  local key; key="$(echo "$B_FIELD" | tr '[:upper:]' '[:lower:]')"
  "$GH" project item-list "$B_NUM" --owner "$B_OWNER" --format json --limit "$limit" \
    | "$JQ" -r --arg s "$status" --arg k "$key" \
      '.items[] | select((.[$k] // "") == $s) | .content.number // empty'
}

# Valid option names of the board's Status field (one per line). Same source
# set-status resolves option ids from, so read validation matches write behavior.
gh_status_option_names() {
  require_board
  "$GH" project field-list "$B_NUM" --owner "$B_OWNER" --format json \
    | "$JQ" -r --arg f "$B_FIELD" '.fields[] | select(.name==$f) | .options[]?.name'
}

# Die unless <name> is an actual column (Status option) on the board. Prevents a
# typo'd / renamed column from silently reading as "no work here" (see #67).
assert_valid_status() {
  local status="$1" names
  names="$(gh_status_option_names)"
  printf '%s\n' "$names" | grep -qxF -- "$status" && return 0
  die "status '$status' is not a column on Project $B_OWNER/#$B_NUM (field '$B_FIELD'); valid: $(printf '%s' "$names" | tr '\n' ' ')"
}

# ---- verbs ------------------------------------------------------------------
verb_select() {
  local status="" dispatchable=0 limit=50; local -a labels=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --status)       status="$2"; shift 2 ;;
      --label)        labels+=("$2"); shift 2 ;;
      --dispatchable) dispatchable=1; shift ;;
      --limit)        limit="$2"; shift 2 ;;
      *) die "select: unknown flag $1" ;;
    esac
  done

  if [ "$PROVIDER" = "none" ]; then
    warn "provider is 'none' — nothing to select."; echo "[]"; return
  fi
  [ "$PROVIDER" = "github" ] || die "provider '$PROVIDER' not implemented by the default adapter (supply .rig/rig-tracker)."

  # --dispatchable = default policy: Todo column AND a shape label.
  if [ "$dispatchable" -eq 1 ]; then
    [ -z "$status" ] && status="$(status_display todo)"
    if [ "${#labels[@]}" -eq 0 ]; then
      while IFS= read -r sl; do [ -n "$sl" ] && labels+=("$sl"); done < <(shape_label_values)
    fi
    [ -n "$status" ] || die "--dispatchable needs tracker.board.statusOptions.todo set"
  fi

  # Validate the board column up front (#67): an unknown/typo'd status must fail
  # loudly rather than silently intersect to [] (which reads as "no work here").
  [ -n "$status" ] && assert_valid_status "$status"

  # Pull SCAN_DEPTH candidates from each source, THEN return the first <limit>
  # matches — never let --limit shrink a source below the overlap (see #66).
  local scan=$(( limit > SCAN_DEPTH ? limit : SCAN_DEPTH ))

  # Candidate set by labels (carries labels[]). Empty labels = all open issues.
  local by_labels; by_labels="$(gh_issues_by_labels "$scan" "${labels[@]}")"

  if [ -z "$status" ]; then
    echo "$by_labels" | "$JQ" -c ".[:$limit]"; return
  fi

  # Intersect with the board's <status> column, and stamp the status.
  local nums; nums="$(gh_issue_numbers_by_status "$status" "$scan" | "$JQ" -R . | "$JQ" -sc 'map(tonumber)')"
  echo "$by_labels" | "$JQ" -c --argjson nums "$nums" --arg st "$status" \
    '[ .[] | select(.number as $n | $nums | index($n)) | .status = $st ] | .[:'"$limit"']'
}

verb_next() { verb_select --dispatchable --limit 1 "$@"; }

verb_link_pr() {
  local issue="${1:?link-pr <issue#> <pr#>}" pr="${2:?link-pr <issue#> <pr#>}"
  if [ "$PROVIDER" != "github" ]; then
    warn "link-pr: provider '$PROVIDER' — no-op."; echo "{\"linked\":false,\"issue\":$issue,\"pr\":$pr}"; return
  fi
  local body ref="$CLOSING_KW #$issue"
  body="$("$GH" pr view "$pr" --json body -q .body 2>/dev/null || echo "")"
  # Already references this issue via a closing keyword? (Closes/Fixes/Resolves)
  if echo "$body" | grep -qiE "(close[sd]?|fix(e[sd])?|resolve[sd]?) #$issue([^0-9]|$)"; then
    echo "{\"linked\":true,\"issue\":$issue,\"pr\":$pr,\"already\":true}"; return
  fi
  local newbody; newbody="$(printf '%s\n\n%s' "$body" "$ref")"
  "$GH" pr edit "$pr" --body "$newbody" >&2
  echo "{\"linked\":true,\"issue\":$issue,\"pr\":$pr,\"already\":false}"
}

verb_set_status() {
  local issue="${1:?set-status <issue#> <status-name>}" status="${2:?set-status <issue#> <status-name>}"
  if [ "$PROVIDER" != "github" ]; then
    warn "set-status: provider '$PROVIDER' — no-op."; echo "{\"moved\":false,\"issue\":$issue}"; return
  fi
  require_board
  # Resolve ProjectV2 ids at runtime (config stays human-friendly, no node IDs).
  local proj_id field_id opt_id item_id fields
  proj_id="$("$GH" project view "$B_NUM" --owner "$B_OWNER" --format json | "$JQ" -r .id)"
  fields="$("$GH" project field-list "$B_NUM" --owner "$B_OWNER" --format json)"
  field_id="$(echo "$fields" | "$JQ" -r --arg f "$B_FIELD" '.fields[] | select(.name==$f) | .id')"
  opt_id="$(echo "$fields" | "$JQ" -r --arg f "$B_FIELD" --arg o "$status" \
    '.fields[] | select(.name==$f) | .options[]? | select(.name==$o) | .id')"
  [ -n "$field_id" ] && [ -n "$opt_id" ] || die "set-status: field '$B_FIELD' / option '$status' not found on the board"
  item_id="$("$GH" project item-list "$B_NUM" --owner "$B_OWNER" --format json --limit 200 \
    | "$JQ" -r --argjson n "$issue" '.items[] | select(.content.number==$n) | .id')"
  [ -n "$item_id" ] || die "set-status: issue #$issue is not on Project $B_OWNER/#$B_NUM (add-to-project first)"
  "$GH" project item-edit --id "$item_id" --field-id "$field_id" --project-id "$proj_id" \
    --single-select-option-id "$opt_id" >&2
  echo "{\"moved\":true,\"issue\":$issue,\"status\":\"$status\"}"
}

verb_add_to_project() {
  local issue="${1:?add-to-project <issue#>}"
  if [ "$PROVIDER" != "github" ]; then
    warn "add-to-project: provider '$PROVIDER' — no-op."; echo "{\"added\":false,\"issue\":$issue}"; return
  fi
  require_board
  local url; url="$("$GH" issue view "$issue" --json url -q .url)"
  "$GH" project item-add "$B_NUM" --owner "$B_OWNER" --url "$url" >&2
  echo "{\"added\":true,\"issue\":$issue}"
}

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- dispatch ---------------------------------------------------------------
[ $# -gt 0 ] || { usage; exit 0; }
verb="$1"; shift
case "$verb" in
  select)          verb_select "$@" ;;
  next)            verb_next "$@" ;;
  link-pr)         verb_link_pr "$@" ;;
  set-status)      verb_set_status "$@" ;;
  add-to-project)  verb_add_to_project "$@" ;;
  -h|--help|help)  usage ;;
  *) die "unknown verb '$verb' (select|next|link-pr|set-status|add-to-project)" ;;
esac
