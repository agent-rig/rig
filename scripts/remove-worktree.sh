#!/usr/bin/env bash
# Safely tear down a git worktree created by setup-worktree.sh: skip if it
# has uncommitted work, otherwise remove the worktree and delete its branch.
#
# The teardown counterpart to setup-worktree.sh. Any prune/rig-tidy flow calls
# this so the skip-if-dirty safety lives in one place.
#
# Usage:
#   remove-worktree.sh <path-or-branch> [options]
#
#   <path-or-branch>   Worktree path (e.g. .claude/rig-worktrees/feat-521-foo) or
#                      the branch checked out in it (e.g. alice/feat-521-foo).
#
# Options:
#   --force-dirty   Remove even if the worktree has uncommitted changes.
#                   Without this, a dirty worktree is SKIPPED (not an error).
#   --keep-branch   Remove the worktree but leave its branch in place.
#
# Exit status is 0 on success AND on skip-because-dirty (skip is a normal
# outcome, not a failure). The first stdout token is the outcome:
#   removed <path>      worktree removed (+ branch deleted unless --keep-branch)
#   skipped <path>      dirty, left in place
#   absent  <arg>       no such worktree
set -euo pipefail

die() { echo "remove-worktree: $*" >&2; exit 1; }

TARGET=""
FORCE_DIRTY=0
KEEP_BRANCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force-dirty) FORCE_DIRTY=1; shift ;;
    --keep-branch) KEEP_BRANCH=1; shift ;;
    --)            shift; break ;;
    -*)            die "unknown flag $1" ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"; else die "too many positional args"; fi
      shift ;;
  esac
done

[ -n "$TARGET" ] || die "missing <path-or-branch> argument"

# awk must NOT `exit` early: with many worktrees that closes the pipe while
# `git worktree list` is still writing → SIGPIPE (141) → pipefail+`set -e` kills
# the script with no output. Read the whole stream; flag-gate the first match.
MAIN=$(git worktree list --porcelain | awk '/^worktree / && !seen { print $2; seen=1 }')
[ -n "$MAIN" ] || die "could not resolve main worktree root"

# Resolve TARGET to a registered worktree path. Accept either an absolute /
# relative path or the branch name checked out in the worktree.
WT_PATH=""
BRANCH=""
cur_path=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) cur_path="${line#worktree }" ;;
    "branch "*)
      cur_branch="${line#branch }"
      cur_branch="${cur_branch#refs/heads/}"
      # Match on path (absolute, relative-to-MAIN, or basename) or branch.
      case "$TARGET" in
        "$cur_path") WT_PATH="$cur_path"; BRANCH="$cur_branch" ;;
        "$MAIN/$TARGET") WT_PATH="$cur_path"; BRANCH="$cur_branch" ;;
        "$cur_branch") WT_PATH="$cur_path"; BRANCH="$cur_branch" ;;
        *) [ "${cur_path##*/}" = "$TARGET" ] && { WT_PATH="$cur_path"; BRANCH="$cur_branch"; } ;;
      esac
      ;;
  esac
done < <(git -C "$MAIN" worktree list --porcelain)

if [ -z "$WT_PATH" ]; then
  echo "absent $TARGET"
  echo "remove-worktree: no registered worktree matches '$TARGET'" >&2
  exit 0
fi

# Never let the main worktree be removed.
[ "$WT_PATH" = "$MAIN" ] && die "refusing to remove the main worktree ($MAIN)"

# Dirty check: uncommitted changes (staged, unstaged, or untracked).
if [ "$FORCE_DIRTY" != "1" ] && [ -n "$(git -C "$WT_PATH" status --porcelain 2>/dev/null)" ]; then
  echo "skipped $WT_PATH"
  echo "remove-worktree: $WT_PATH has uncommitted changes; left in place (pass --force-dirty to override)" >&2
  exit 0
fi

# Route git's chatter to stderr so stdout carries only the outcome token.
git -C "$MAIN" worktree remove --force "$WT_PATH" >&2
if [ "$KEEP_BRANCH" != "1" ] && [ -n "$BRANCH" ]; then
  # -D (force) — the branch may be unmerged locally even when its PR is merged
  # on origin (squash/rebase merges don't fast-forward the local ref).
  git -C "$MAIN" branch -D "$BRANCH" >/dev/null 2>&1 || true
fi
git -C "$MAIN" worktree prune >&2

echo "removed $WT_PATH"
echo "remove-worktree: removed $WT_PATH${KEEP_BRANCH:+ (kept branch)}" >&2
