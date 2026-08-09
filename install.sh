#!/usr/bin/env bash
#
# Non-agent installer for Rig.
#
# Delivers the skills, agents, scripts, and starter support docs into a target
# project in the conventions of whichever AI coding agent(s) that project uses,
# and drops a shared .rig/config.json profile. CI workflows are NOT installed
# here — they need per-project parameterization; see ci/README.md, or use the
# agent-driven `rig-onboard` skill.
#
# Usage:
#   ./install.sh [--target <a,b>] <target-project-dir> [skill ...]
#
# Targets (adapters):
#   claude-code  -> .claude/skills/<name>/, .claude/agents/, .claude/scripts/
#   agents-md    -> .agents/skills/<name>/ (the cross-agent Agent Skills
#                   standard, auto-discovered natively by Codex, Cursor,
#                   Gemini CLI, Copilot, Rovo Dev, ...), plus .rig/agents/,
#                   .rig/scripts/, .rig/REVIEWER.md for the pieces the
#                   standard doesn't cover, and a minimal idempotent "## Rig"
#                   pointer block injected into AGENTS.md (config profile +
#                   persona-adoption note - no per-skill listing, since
#                   .agents/skills/ is self-discovered).
#
# With no --target, the target agent(s) are auto-detected from repo markers
# (falling back to claude-code). Repeat/comma-separate to install several.
# With no skill list, installs the recommended default set. Existing files are
# never overwritten.
#
# Installing BOTH targets keeps one physical payload: the skills/agents/scripts
# land in .agents/ + .rig/, and .claude/ is symlinked at them (Claude Code
# follows symlinks) so there's a single source of truth to edit. Where symlinks
# aren't available, .claude/ falls back to its own copy.

set -euo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGETS_CSV=""
POSARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGETS_CSV+="${TARGETS_CSV:+,}$2"; shift 2 ;;
    --target=*) TARGETS_CSV+="${TARGETS_CSV:+,}${1#--target=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) POSARGS+=("$1"); shift ;;
  esac
done

TARGET="${POSARGS[0]:-}"
SKILLS=("${POSARGS[@]:1}")

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 [--target <a,b>] <target-project-dir> [skill ...]" >&2
  exit 2
fi
if [[ ! -d "$TARGET" ]]; then
  echo "error: target '$TARGET' is not a directory" >&2
  exit 2
fi
TARGET="$(cd "$TARGET" && pwd)"
if [[ "$TARGET" == "$RIG_DIR" ]]; then
  echo "error: target is the kit itself" >&2
  exit 2
fi

DEFAULT_SKILLS=(rig-doctor rig-debug rig-spike rig-tidy rig-review rig-issue rig-worktree rig-task rig-plan rig-sprint rig-epic)
if [[ ${#SKILLS[@]} -eq 0 ]]; then
  SKILLS=("${DEFAULT_SKILLS[@]}")
fi

# --- Resolve target adapters -------------------------------------------------
detect_targets() {
  local found=()
  if [[ -d "$TARGET/.claude" || -f "$TARGET/CLAUDE.md" ]]; then found+=(claude-code); fi
  if [[ -f "$TARGET/AGENTS.md" || -d "$TARGET/.agents" || -d "$TARGET/.cursor" \
        || -f "$TARGET/.github/copilot-instructions.md" || -f "$TARGET/GEMINI.md" \
        || -d "$TARGET/.windsurf" ]]; then found+=(agents-md); fi
  if [[ ${#found[@]} -eq 0 ]]; then found=(claude-code); fi   # safe default
  printf '%s\n' "${found[@]}"
}

if [[ -n "$TARGETS_CSV" ]]; then
  IFS=',' read -r -a TARGETS <<< "$TARGETS_CSV"
else
  mapfile -t TARGETS < <(detect_targets)
  echo "No --target given; auto-detected: ${TARGETS[*]}"
fi

has_target() { local t; for t in "${TARGETS[@]}"; do [[ "$t" == "$1" ]] && return 0; done; return 1; }

# Both adapters on one repo would otherwise lay down two physical copies of
# every skill/agent/script — two sources of truth, one edit away from drifting.
# Claude Code follows symlinks for skill dirs (and plain files), so when both
# targets are installed we keep ONE payload (.agents/ + .rig/, the locations
# other agents discover natively) and point .claude/ at it. Requires symlink
# support: without it (Windows sans developer mode) we fall back to copying.
DEDUPE=0
if has_target claude-code && has_target agents-md; then
  probe="$TARGET/.rig-symlink-probe"
  rm -f "$probe" 2>/dev/null || true
  if ln -s . "$probe" 2>/dev/null && [[ -L "$probe" ]]; then
    DEDUPE=1
  else
    echo "note: symlinks unavailable here — .claude/ gets its own copy of the payload."
  fi
  rm -f "$probe" 2>/dev/null || true
fi

# Both adapters run on a dual-target install, and claude-code links at what
# agents-md lays down — so agents-md has to go first.
if [[ $DEDUPE -eq 1 ]]; then TARGETS=(agents-md claude-code); fi

copy_no_clobber() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    echo "  skip (exists): ${dst#$TARGET/}"
  else
    mkdir -p "$(dirname "$dst")"
    cp -R "$src" "$dst"
    echo "  copied: ${dst#$TARGET/}"
  fi
}

# $1 = link text, relative to $2's own directory (so the link survives a clone
# or a moved checkout); $2 = where the symlink goes.
link_no_clobber() {
  local rel="$1" dst="$2"
  if [[ -e "$dst" || -L "$dst" ]]; then
    echo "  skip (exists): ${dst#$TARGET/}"
  else
    mkdir -p "$(dirname "$dst")"
    ln -s "$rel" "$dst"
    echo "  linked: ${dst#$TARGET/} -> $rel"
  fi
}

# Copy, or symlink at the already-installed .agents//.rig/ payload when we're
# deduping. $1 = source in the kit, $2 = destination under .claude/, $3 = link
# text relative to $2's directory.
place() {
  if [[ $DEDUPE -eq 1 ]]; then link_no_clobber "$3" "$2"; else copy_no_clobber "$1" "$2"; fi
}

# --- Shared: project profile (agent-agnostic) --------------------------------
write_profile() {
  if [[ -e "$TARGET/.rig/config.json" ]]; then
    echo "  skip (exists): .rig/config.json"
  else
    mkdir -p "$TARGET/.rig"
    cp "$RIG_DIR/rig.config.example.json" "$TARGET/.rig/config.json"
    cp "$RIG_DIR/rig.schema.json" "$TARGET/.rig/schema.json"
    echo "  wrote: .rig/config.json  (EDIT THIS — it currently holds the example values)"
  fi
}

# --- Adapter: claude-code ----------------------------------------------------
# When DEDUPE=1 every "copy" below becomes a symlink at the payload agents-md
# already installed; .claude/skills/<n> and .claude/{agents,scripts}/<f> are two
# levels down from the repo root, the support docs one.
install_claude_code() {
  if [[ $DEDUPE -eq 1 ]]; then
    echo "[claude-code] skills -> .claude/skills/ (symlinked at .agents/skills/)"
  else
    echo "[claude-code] skills -> .claude/skills/"
  fi
  for s in "${SKILLS[@]}"; do
    if [[ -d "$RIG_DIR/skills/$s" ]]; then
      place "$RIG_DIR/skills/$s" "$TARGET/.claude/skills/$s" "../../.agents/skills/$s"
    else echo "  unknown skill: $s" >&2; fi
  done
  echo "[claude-code] agents -> .claude/agents/"
  for a in "$RIG_DIR"/agents/*.md; do
    [[ -e "$a" ]] || continue
    place "$a" "$TARGET/.claude/agents/$(basename "$a")" "../../.rig/agents/$(basename "$a")"
  done
  echo "[claude-code] scripts -> .claude/scripts/"
  for f in "$RIG_DIR"/scripts/*; do
    [[ -e "$f" ]] || continue
    if [[ "$f" == *.test.* ]]; then continue; fi   # kit-internal tests aren't shipped
    place "$f" "$TARGET/.claude/scripts/$(basename "$f")" "../../.rig/scripts/$(basename "$f")"
  done
  chmod +x "$TARGET"/.claude/scripts/*.sh 2>/dev/null || true
  echo "[claude-code] support docs (only if absent) -> .claude/"
  for doc in REVIEWER.md label-mapping.md; do
    if [[ -e "$RIG_DIR/templates/$doc" ]]; then
      place "$RIG_DIR/templates/$doc" "$TARGET/.claude/$doc" "../.rig/$doc"
    fi
  done
}

# --- Adapter: agents-md (universal) ------------------------------------------
install_agents_md() {
  echo "[agents-md] skills -> .agents/skills/<name>/ (cross-agent Agent Skills standard)"
  for s in "${SKILLS[@]}"; do
    if [[ -d "$RIG_DIR/skills/$s" ]]; then copy_no_clobber "$RIG_DIR/skills/$s" "$TARGET/.agents/skills/$s"
    else echo "  unknown skill: $s" >&2; fi
  done
  echo "[agents-md] agents -> .rig/agents/, scripts -> .rig/scripts/"
  for a in "$RIG_DIR"/agents/*.md; do [[ -e "$a" ]] || continue; copy_no_clobber "$a" "$TARGET/.rig/agents/$(basename "$a")"; done
  for f in "$RIG_DIR"/scripts/*; do
    [[ -e "$f" ]] || continue
    if [[ "$f" == *.test.* ]]; then continue; fi   # kit-internal tests aren't shipped
    copy_no_clobber "$f" "$TARGET/.rig/scripts/$(basename "$f")"
  done
  chmod +x "$TARGET"/.rig/scripts/*.sh 2>/dev/null || true
  for doc in REVIEWER.md label-mapping.md; do
    if [[ -e "$RIG_DIR/templates/$doc" ]]; then copy_no_clobber "$RIG_DIR/templates/$doc" "$TARGET/.rig/$doc"; fi
  done

  # Build the index block.
  local block
  block="$(
    echo "## Rig"
    echo
    echo "This project uses [Rig](https://github.com/agent-rig/rig) skills, delivered as"
    echo "standard Agent Skills under \`.agents/skills/\` — your agent discovers and"
    echo "invokes them automatically from each skill's trigger description; nothing to"
    echo "do here to use them."
    echo
    echo "Project config lives in \`.rig/config.json\` — read it for the test command,"
    echo "base branch, tracker, and review-bot settings before running any skill."
    echo
    echo "**Roles/subagents:** personas live in \`.rig/agents/\` (rig-reviewer, rig-coder,"
    echo "rig-architect, rig-qa, rig-debugger). If your agent supports subagents,"
    echo "delegate to the named persona; otherwise adopt that persona's instructions"
    echo "inline. Helper scripts are in \`.rig/scripts/\`; review patterns in"
    echo "\`.rig/REVIEWER.md\` (set \`review.patternsFile\` accordingly)."
  )"

  local F="$TARGET/AGENTS.md"
  local S="<!-- rig:start -->" E="<!-- rig:end -->"
  if [[ -f "$F" ]]; then
    awk -v s="$S" -v e="$E" '$0==s{skip=1} skip&&$0==e{skip=0;next} !skip{print}' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
  else
    printf '# AGENTS.md\n' > "$F"
    echo "[agents-md] created AGENTS.md"
  fi
  { printf '\n%s\n' "$S"; printf '%s\n' "$block"; printf '%s\n' "$E"; } >> "$F"
  echo "[agents-md] injected ## Rig index into AGENTS.md (idempotent)"
}

# --- Run ---------------------------------------------------------------------
echo "Installing Rig into: $TARGET"
echo "Targets: ${TARGETS[*]}"
echo "Skills:  ${SKILLS[*]}"
echo

for t in "${TARGETS[@]}"; do
  case "$t" in
    claude-code) install_claude_code ;;
    agents-md)   install_agents_md ;;
    *) echo "unknown target: $t (known: claude-code, agents-md)" >&2; exit 2 ;;
  esac
  echo
done

echo "Project profile:"
write_profile

cat <<EOF

Done. Next:
  1. Edit $TARGET/.rig/config.json for your project (see docs/config.md).
  2. For CI workflows, see $RIG_DIR/ci/README.md (copy + parameterize by hand).
  3. Or run the 'rig-onboard' skill in your agent for the guided setup.
EOF
