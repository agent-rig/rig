#!/usr/bin/env bash
# Boot the dev stack (db, backend, frontend/bundler) for manual QA in a
# worktree, each backgrounded with its own log file and PID recorded in a
# metadata file that remove-worktree.sh reads to tear everything down before
# removing the worktree. This is the mechanical half of /rig-preview — the
# skill drives the iOS Simulator / Browser preview tools on top of this,
# since only the calling agent (not a shell script) can invoke those.
#
# Usage:
#   preview-env.sh start --worktree <path> [--backend "<cmd>"] [--db "<cmd>"] \
#                         --frontend "<cmd>" --port <n> [--force-kill-port] \
#                         [--mobile]
#
# Any of --backend/--db may be omitted (nothing to boot for that tier).
# --frontend and --port are required — there is always something to preview.
#
# Port safety: if something is already listening on --port, this script will
# NOT blindly kill it. It first checks every OTHER worktree's own
# .rig-preview.json (written by a prior `start`) to see whether the port's
# owner belongs to a worktree that still exists:
#   - belongs to a worktree that's gone (removed without going through
#     remove-worktree.sh, or the process outlived a crash) -> stale, kill it.
#   - belongs to a worktree that still exists -> refuse; two previews can't
#     share a port. Pass --force-kill-port to override, or pick a free --port.
#   - doesn't match any known worktree's metadata -> refuse (unrelated to any
#     tracked preview; killing it blind is how the stale-8081 bug happened
#     during this kit's own development). --force-kill-port overrides.
#
# Device allocation (--mobile only): same shape of problem, one level up.
# Two worktrees building the same bundle identifier onto the SAME simulator
# device silently overwrite each other's install — the port check catches
# nothing here since the collision is at install time, not the bundler.
# So with --mobile this script also assigns a simulator device exclusive to
# this worktree:
#   1. Reuse this worktree's own previously-assigned device (from a prior
#      run's metadata), if it still exists.
#   2. Else, the first already-BOOTED device not claimed by another live
#      worktree's .rig-preview.json.
#   3. Else, the first available-but-shutdown device not claimed by anyone;
#      boot it.
#   4. Else, refuse — every device is claimed or none exist. This script does
#      not create new simulator devices; that's a provisioning decision for a
#      human (`xcrun simctl create` / Xcode), not something to do silently.
#
# Writes <worktree>/.rig-preview.json:
#   {"pids": [<db-pid>, <backend-pid>, <frontend-pid>], "port": <n>,
#    "device": "<udid or omitted>",
#    "logs": {"db": "<path>", "backend": "<path>", "frontend": "<path>"}}
set -euo pipefail

die() { echo "preview-env: $*" >&2; exit 1; }

CMD="${1:-}"; shift || true
[ "$CMD" = "start" ] || die "usage: preview-env.sh start --worktree <path> --frontend \"<cmd>\" --port <n> [--backend \"<cmd>\"] [--db \"<cmd>\"] [--force-kill-port] [--mobile]"

WT=""
BACKEND_CMD=""
DB_CMD=""
FRONTEND_CMD=""
PORT=""
FORCE_KILL=0
MOBILE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)         WT="$2"; shift 2 ;;
    --backend)          BACKEND_CMD="$2"; shift 2 ;;
    --db)               DB_CMD="$2"; shift 2 ;;
    --frontend)         FRONTEND_CMD="$2"; shift 2 ;;
    --port)             PORT="$2"; shift 2 ;;
    --force-kill-port)  FORCE_KILL=1; shift ;;
    --mobile)           MOBILE=1; shift ;;
    *)                  die "unknown flag $1" ;;
  esac
done

[ -n "$WT" ] || die "missing --worktree <path>"
[ -d "$WT" ] || die "worktree path does not exist: $WT"
[ -n "$FRONTEND_CMD" ] || die "missing --frontend \"<cmd>\" — there is always a frontend/bundler to preview"
[ -n "$PORT" ] || die "missing --port <n>"

MAIN=$(git -C "$WT" worktree list --porcelain | awk '/^worktree / && !seen { print $2; seen=1 }')
[ -n "$MAIN" ] || die "could not resolve main worktree root"

other_worktrees() {
  git -C "$MAIN" worktree list --porcelain | awk '/^worktree / {print $2}' | grep -vFx "$WT" || true
}

# --- Port safety: is something already on $PORT, and if so, whose is it? ---
# `lsof` finds whoever actually holds the socket, which may be several forks
# below the process group leader `start_one` recorded (npx -> the real CLI).
# Recorded pids ARE their own group's PGID by construction (see start_one),
# so resolve the listener's PGID and compare THAT against recorded pids —
# comparing raw PIDs would miss every case where the listener is a
# grandchild, which in practice is most of them.
#
# Ownership is checked against EVERY worktree, including this one: a process
# this same worktree started on a prior run is a restart, not a conflict, and
# should be replaced freely — only a DIFFERENT worktree's process (or one
# that matches nothing we track) needs a human decision.
EXISTING_PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
if [ -n "$EXISTING_PID" ]; then
  EXISTING_PGID=$(ps -o pgid= -p "$EXISTING_PID" 2>/dev/null | tr -d ' ')
  KILL_TARGET="${EXISTING_PGID:-$EXISTING_PID}"

  OWNER_WT=""
  while IFS= read -r wpath; do
    meta="$wpath/.rig-preview.json"
    [ -f "$meta" ] || continue
    if grep -qE "(^|[^0-9])$KILL_TARGET([^0-9]|$)" "$meta" 2>/dev/null; then
      OWNER_WT="$wpath"
      break
    fi
  done < <(git -C "$MAIN" worktree list --porcelain | awk '/^worktree / {print $2}')

  if [ "$OWNER_WT" = "$WT" ]; then
    echo "preview-env: port $PORT held by this worktree's own prior run (group $KILL_TARGET) — restarting" >&2
    kill -- "-$KILL_TARGET" 2>/dev/null || true
    sleep 1
  elif [ "$FORCE_KILL" = "1" ]; then
    echo "preview-env: killing process group $KILL_TARGET on port $PORT (--force-kill-port)" >&2
    kill -- "-$KILL_TARGET" 2>/dev/null || true
    sleep 1
  elif [ -n "$OWNER_WT" ]; then
    die "port $PORT is in use by a live preview in $OWNER_WT — pick a different --port, or stop that one first (--force-kill-port to override, not recommended while it's in active use)"
  else
    die "port $PORT is in use by PID $EXISTING_PID (group $KILL_TARGET), not tracked by any current worktree's preview — refusing to kill an unrelated process. Pass --force-kill-port if you're sure, or pick a different --port"
  fi
fi

# --- Device allocation (--mobile only) ---
DEVICE=""
if [ "$MOBILE" = "1" ]; then
  CLAIMED_FILE=$(mktemp)
  trap 'rm -f "$CLAIMED_FILE"' EXIT
  while IFS= read -r wpath; do
    meta="$wpath/.rig-preview.json"
    [ -f "$meta" ] || continue
    { grep -o '"device": *"[^"]*"' "$meta" | sed 's/.*: *"//;s/"$//'; } >> "$CLAIMED_FILE" || true
  done < <(other_worktrees)

  is_claimed() { grep -qFx "$1" "$CLAIMED_FILE" 2>/dev/null; }
  udid_of() { grep -oE '[0-9A-Fa-f-]{36}' <<< "$1" | head -1 || true; }

  # 1. Reuse this worktree's own previously-assigned device, if it still exists.
  if [ -f "$WT/.rig-preview.json" ]; then
    PREV=$(grep -o '"device": *"[^"]*"' "$WT/.rig-preview.json" 2>/dev/null | sed 's/.*: *"//;s/"$//' || true)
    if [ -n "$PREV" ] && xcrun simctl list devices available 2>/dev/null | grep -q "$PREV"; then
      DEVICE="$PREV"
      echo "preview-env: reusing this worktree's previously-assigned device $DEVICE" >&2
    fi
  fi

  # 2. First already-booted device not claimed by another live worktree.
  if [ -z "$DEVICE" ]; then
    while IFS= read -r line; do
      udid=$(udid_of "$line")
      [ -n "$udid" ] || continue
      if ! is_claimed "$udid"; then DEVICE="$udid"; echo "preview-env: allocated already-booted device $DEVICE" >&2; break; fi
    done < <(xcrun simctl list devices booted 2>/dev/null | grep -v "^--")
  fi

  # 3. First available-but-shutdown device not claimed by anyone; boot it.
  if [ -z "$DEVICE" ]; then
    while IFS= read -r line; do
      udid=$(udid_of "$line")
      [ -n "$udid" ] || continue
      if ! is_claimed "$udid"; then
        DEVICE="$udid"
        echo "preview-env: booting free device $DEVICE..." >&2
        xcrun simctl boot "$DEVICE" 2>/dev/null || true
        break
      fi
    done < <(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone|iPad" | grep -v "^--")
  fi

  [ -n "$DEVICE" ] || die "no free simulator device — every existing device is claimed by another live preview. Create one (xcrun simctl create, or Xcode > Devices) and retry."
fi

mkdir -p "$WT/.rig-preview"
PIDS=()
LOGS_JSON="{"

# --port here only drove OUR OWN safety check above — the underlying command
# has no idea what port we intend unless we tell it. FRONTEND_CMD must
# contain a literal "{port}" placeholder (e.g. "npx expo start --port
# {port}"); substitute it now. Without this, two worktrees both defaulting
# to the same framework-default port collide despite --port claiming they
# don't — exactly what happened developing this script: the second instance
# silently skipped starting (non-interactive, so it couldn't prompt "use a
# different port?") while this script reported success.
if [[ "$FRONTEND_CMD" == *"{port}"* ]]; then
  FRONTEND_CMD="${FRONTEND_CMD//\{port\}/$PORT}"
else
  echo "preview-env: WARNING — dev.frontendCommand has no {port} placeholder; the command will use its own default port, which may not be $PORT and may collide with another worktree" >&2
fi

# A dev command (npx, npm run, etc.) typically forks a grandchild that does
# the actual work — `$!` after a plain `cmd &` only ever gives you the
# wrapper's PID, and killing just that PID can leave the real process (the
# one holding the port) running. macOS has no `setsid`, so the portable fix
# is bash's own job control: `set -m` in a subshell before backgrounding puts
# that job in its OWN process group, whose PGID equals its PID — so `kill --
# -<PID>` (negative) kills the whole tree, wrapper and grandchildren alike,
# regardless of how many layers deep the actual process ends up.
start_one() {
  local name="$1" cmd="$2"
  local log="$WT/.rig-preview/$name.log"
  echo "preview-env: starting $name ($cmd)..." >&2
  (
    set -m
    cd "$WT" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 nohup bash -c "$cmd" > "$log" 2>&1 &
    echo $! > "$WT/.rig-preview/$name.pid"
  )
  sleep 1
  local pid
  pid=$(cat "$WT/.rig-preview/$name.pid")
  PIDS+=("$pid")
  LOGS_JSON="$LOGS_JSON\"$name\":\"$log\","
  echo "preview-env: $name started, process group $pid, log $log" >&2
}

[ -n "$DB_CMD" ] && start_one "db" "$DB_CMD"
[ -n "$BACKEND_CMD" ] && start_one "backend" "$BACKEND_CMD"
start_one "frontend" "$FRONTEND_CMD"

LOGS_JSON="${LOGS_JSON%,}}"
PIDS_JSON=$(IFS=,; echo "${PIDS[*]}")

if [ -n "$DEVICE" ]; then
  cat > "$WT/.rig-preview.json" <<EOF
{"pids": [$PIDS_JSON], "port": $PORT, "device": "$DEVICE", "logs": $LOGS_JSON}
EOF
else
  cat > "$WT/.rig-preview.json" <<EOF
{"pids": [$PIDS_JSON], "port": $PORT, "logs": $LOGS_JSON}
EOF
fi

echo "preview-env: ready — metadata at $WT/.rig-preview.json" >&2
echo "$WT/.rig-preview.json"
