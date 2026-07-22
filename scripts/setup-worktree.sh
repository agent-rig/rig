#!/usr/bin/env bash
# Create (or reuse) an isolated git worktree wired up for development:
# fetch first, branch from the right base, symlink env files, install deps.
#
# This is the shared worktree-bootstrap used by the /rig-worktree skill and any
# implement-style flow. Keeping it in one script means the three hard-won
# invariants (fetch-before-branch, env symlinks, per-worktree install) live in
# exactly one place.
#
# Usage:
#   setup-worktree.sh <branch> [options]
#
#   <branch>              Branch to create/check out in the worktree,
#                         e.g. alice/feat-521-rename or feat-679-observability.
#
# Options:
#   --base <ref>          Base ref to branch from. Default: origin/main
#                         (override with --base or the WORKTREE_BASE_REF env var,
#                         e.g. from vcs.baseRef in .rig/config.json).
#                         Pass origin/<integration-branch> for stacked children.
#   --path <path>         Worktree path. Default:
#                         .claude/rig-worktrees/<basename-of-branch>.
#   --reuse               If the worktree (or branch) already exists, reuse it:
#                         fetch + hard-reset to <base> instead of failing.
#                         Without this, an existing path/branch is an error.
#   --no-install          Skip the dependency install in the new worktree.
#   --install-cmd <cmd>   Command to install dependencies inside the worktree.
#                         Default: $WORKTREE_INSTALL_CMD, else "npm install".
#                         Derive from runtime.installCommand / packageManager
#                         in .rig/config.json (e.g. "bun install").
#   --name <session-name> Optional display name for the background job /
#                         session. Delegates to an OPTIONAL set-session-name.sh
#                         sitting next to this script; a no-op if that script is
#                         absent (it is not shipped with the kit).
#   --skip-if-prefix <p>  Passed through to set-session-name.sh: leave an
#                         existing name in place if it starts with <p>.
#
# On success the absolute worktree path is printed as the LAST line of
# stdout, so callers can `WT=$(setup-worktree.sh ... | tail -1)`.
set -euo pipefail

die() { echo "setup-worktree: $*" >&2; exit 1; }

BRANCH=""
BASE="${WORKTREE_BASE_REF:-origin/main}"
WT_PATH=""
REUSE=0
INSTALL=1
INSTALL_CMD="${WORKTREE_INSTALL_CMD:-npm install}"
SESSION_NAME=""
SKIP_PREFIX=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base)            BASE="$2"; shift 2 ;;
    --path)            WT_PATH="$2"; shift 2 ;;
    --reuse)           REUSE=1; shift ;;
    --no-install)      INSTALL=0; shift ;;
    --install-cmd)     INSTALL_CMD="$2"; shift 2 ;;
    --name)            SESSION_NAME="$2"; shift 2 ;;
    --skip-if-prefix)  SKIP_PREFIX="$2"; shift 2 ;;
    --)                shift; break ;;
    -*)                die "unknown flag $1" ;;
    *)
      if [ -z "$BRANCH" ]; then BRANCH="$1"; else die "too many positional args"; fi
      shift ;;
  esac
done

[ -n "$BRANCH" ] || die "missing <branch> argument"

# Resolve the MAIN worktree root (first entry of `git worktree list`), not the
# cwd — this script may itself be invoked from inside a worktree, and env files
# / installed deps we want to source live in the primary checkout.
#
# NB: awk must NOT `exit` on the first match. With many worktrees, exiting early
# closes the pipe while `git worktree list` is still writing → git gets SIGPIPE
# (exit 141) → `set -o pipefail` + `set -e` kills the script before it prints
# anything. Read the whole stream; gate on a flag to emit only the first match.
MAIN=$(git worktree list --porcelain | awk '/^worktree / && !seen { print $2; seen=1 }')
[ -n "$MAIN" ] || die "could not resolve main worktree root"

# Default worktree path: .claude/rig-worktrees/<last segment of branch>.
if [ -z "$WT_PATH" ]; then
  WT_PATH="$MAIN/.claude/rig-worktrees/${BRANCH##*/}"
fi
# Normalize to absolute.
case "$WT_PATH" in
  /*) : ;;
  *)  WT_PATH="$MAIN/$WT_PATH" ;;
esac

# Optional session name (do it early so any job list updates even if a later
# step is slow). set-session-name.sh is OPTIONAL and not shipped with the kit;
# if it isn't present next to this script, this block is a no-op.
if [ -n "$SESSION_NAME" ]; then
  set_name="$MAIN/.claude/scripts/set-session-name.sh"
  if [ -x "$set_name" ]; then
    if [ -n "$SKIP_PREFIX" ]; then
      "$set_name" "$SESSION_NAME" --skip-if-prefix "$SKIP_PREFIX" || true
    else
      "$set_name" "$SESSION_NAME" || true
    fi
  fi
fi

# ALWAYS fetch first. `git worktree add` branches from whatever origin/<base>
# points to *locally*, which can be hours stale and silently put you on a
# pre-merge tip.
echo "setup-worktree: fetching origin..." >&2
git -C "$MAIN" fetch origin

if [ -d "$WT_PATH" ]; then
  if [ "$REUSE" = "1" ]; then
    echo "setup-worktree: reusing existing worktree at $WT_PATH" >&2
    git -C "$WT_PATH" fetch origin
    # Make sure the branch is checked out, then snap it to the base ref.
    git -C "$WT_PATH" checkout "$BRANCH" 2>/dev/null \
      || git -C "$WT_PATH" checkout -B "$BRANCH" "$BASE"
    git -C "$WT_PATH" reset --hard "$BASE"
  else
    die "worktree path already exists: $WT_PATH (pass --reuse to reset it)"
  fi
else
  # Create the worktree. -B so an already-existing local branch is reset to
  # base rather than erroring; this matches a stacked integration-branch flow.
  if [ "$REUSE" = "1" ]; then
    git -C "$MAIN" worktree add -B "$BRANCH" "$WT_PATH" "$BASE"
  else
    git -C "$MAIN" worktree add -b "$BRANCH" "$WT_PATH" "$BASE"
  fi
fi

# Symlink every gitignored env file from MAIN into the worktree. A worktree is
# a fresh checkout — .env, .env.local, and friends are NOT carried over, and
# missing secrets look like flaky/timeout test failures, not "config not found".
# Symlinks (not copies) so edits in MAIN propagate; ln -sfn is idempotent.
echo "setup-worktree: symlinking env files..." >&2
(
  cd "$MAIN"
  git ls-files --others --ignored --exclude-standard
) | grep -v '/node_modules/' | grep -v '^node_modules/' \
  | grep -v '\.example$' \
  | grep -E '(^|/)\.env(\.[^/]+)?$' \
  | while read -r f; do
      mkdir -p "$WT_PATH/$(dirname "$f")"
      ln -sfn "$MAIN/$f" "$WT_PATH/$f"
    done

# Installed deps (node_modules and lockfile state) don't carry across
# worktrees. Missing deps → "Cannot find package '...'". Install, don't symlink.
if [ "$INSTALL" = "1" ]; then
  echo "setup-worktree: installing deps ($INSTALL_CMD)..." >&2
  (cd "$WT_PATH" && eval "$INSTALL_CMD")
fi

echo "setup-worktree: ready at $WT_PATH" >&2
# LAST line of stdout = the worktree path, for `WT=$(... | tail -1)`.
echo "$WT_PATH"
