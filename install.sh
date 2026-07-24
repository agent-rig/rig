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
#   ./install.sh [--target <a,b>] [--with-smithers] <target-project-dir> [skill ...]
#
# --with-smithers  Also scaffold Smithers (smithers.sh), a complementary
#                  crash-resistant AI-workflow orchestrator, via
#                  `bunx|npx smithers-orchestrator init`. Opt-in; needs a JS
#                  runtime (bun preferred, else node/npx). See README "Pairs
#                  with Smithers".
#
# Targets (adapters):
#   claude-code  -> .claude/skills/<name>/, .claude/agents/, .claude/scripts/
#   agents-md    -> rig/skills/<name>.md + rig/agents/ + rig/scripts/, and an
#                   idempotent "## Rig" index injected into AGENTS.md. Works for
#                   any AGENTS.md-reading agent (Codex, Cursor, Gemini, Amp,
#                   Zed, Jules, ...).
#
# With no --target, the target agent(s) are auto-detected from repo markers
# (falling back to claude-code). Repeat/comma-separate to install several.
# With no skill list, installs the recommended default set. Existing files are
# never overwritten.

set -euo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGETS_CSV=""
WITH_SMITHERS=0
POSARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGETS_CSV+="${TARGETS_CSV:+,}$2"; shift 2 ;;
    --target=*) TARGETS_CSV+="${TARGETS_CSV:+,}${1#--target=}"; shift ;;
    --with-smithers) WITH_SMITHERS=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
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

DEFAULT_SKILLS=(rig-debug rig-spike rig-tidy rig-review rig-issue rig-worktree rig-task rig-sprint rig-epic)
if [[ ${#SKILLS[@]} -eq 0 ]]; then
  SKILLS=("${DEFAULT_SKILLS[@]}")
fi

# --- Resolve target adapters -------------------------------------------------
detect_targets() {
  local found=()
  if [[ -d "$TARGET/.claude" || -f "$TARGET/CLAUDE.md" ]]; then found+=(claude-code); fi
  if [[ -f "$TARGET/AGENTS.md" || -d "$TARGET/.cursor" || -f "$TARGET/.github/copilot-instructions.md" \
        || -f "$TARGET/GEMINI.md" || -d "$TARGET/.windsurf" ]]; then found+=(agents-md); fi
  if [[ ${#found[@]} -eq 0 ]]; then found=(claude-code); fi   # safe default
  printf '%s\n' "${found[@]}"
}

if [[ -n "$TARGETS_CSV" ]]; then
  IFS=',' read -r -a TARGETS <<< "$TARGETS_CSV"
else
  mapfile -t TARGETS < <(detect_targets)
  echo "No --target given; auto-detected: ${TARGETS[*]}"
fi

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
install_claude_code() {
  echo "[claude-code] skills -> .claude/skills/"
  for s in "${SKILLS[@]}"; do
    if [[ -d "$RIG_DIR/skills/$s" ]]; then copy_no_clobber "$RIG_DIR/skills/$s" "$TARGET/.claude/skills/$s"
    else echo "  unknown skill: $s" >&2; fi
  done
  echo "[claude-code] agents -> .claude/agents/"
  for a in "$RIG_DIR"/agents/*.md; do
    [[ -e "$a" ]] || continue; copy_no_clobber "$a" "$TARGET/.claude/agents/$(basename "$a")"
  done
  echo "[claude-code] scripts -> .claude/scripts/"
  for f in "$RIG_DIR"/scripts/*; do
    [[ -e "$f" ]] || continue
    if [[ "$f" == *.test.* ]]; then continue; fi   # kit-internal tests aren't shipped
    copy_no_clobber "$f" "$TARGET/.claude/scripts/$(basename "$f")"
  done
  chmod +x "$TARGET"/.claude/scripts/*.sh 2>/dev/null || true
  echo "[claude-code] support docs (only if absent) -> .claude/"
  for doc in REVIEWER.md label-mapping.md; do
    if [[ -e "$RIG_DIR/templates/$doc" ]]; then copy_no_clobber "$RIG_DIR/templates/$doc" "$TARGET/.claude/$doc"; fi
  done
}

# --- Adapter: agents-md (universal) ------------------------------------------
skill_desc() {   # extract the frontmatter description of a skill, unquoted
  grep -m1 '^description:' "$RIG_DIR/skills/$1/SKILL.md" 2>/dev/null \
    | sed -E 's/^description:[[:space:]]*//; s/^"//; s/"[[:space:]]*$//' || true
}

install_agents_md() {
  echo "[agents-md] skills -> rig/skills/*.md"
  for s in "${SKILLS[@]}"; do
    if [[ -f "$RIG_DIR/skills/$s/SKILL.md" ]]; then copy_no_clobber "$RIG_DIR/skills/$s/SKILL.md" "$TARGET/rig/skills/$s.md"
    else echo "  unknown skill: $s" >&2; fi
  done
  echo "[agents-md] agents -> rig/agents/, scripts -> rig/scripts/"
  for a in "$RIG_DIR"/agents/*.md; do [[ -e "$a" ]] || continue; copy_no_clobber "$a" "$TARGET/rig/agents/$(basename "$a")"; done
  for f in "$RIG_DIR"/scripts/*; do
    [[ -e "$f" ]] || continue
    if [[ "$f" == *.test.* ]]; then continue; fi   # kit-internal tests aren't shipped
    copy_no_clobber "$f" "$TARGET/rig/scripts/$(basename "$f")"
  done
  chmod +x "$TARGET"/rig/scripts/*.sh 2>/dev/null || true
  for doc in REVIEWER.md label-mapping.md; do
    if [[ -e "$RIG_DIR/templates/$doc" ]]; then copy_no_clobber "$RIG_DIR/templates/$doc" "$TARGET/rig/$doc"; fi
  done

  # Build the index block.
  local block
  block="$(
    echo "## Rig"
    echo
    echo "This project uses [Rig](https://github.com/agent-rig/rig) skills — self-contained"
    echo "markdown procedures. **When a request matches a skill's triggers, read that"
    echo "file and follow it.** Project config lives in \`.rig/config.json\`."
    echo
    for s in "${SKILLS[@]}"; do
      [[ -f "$RIG_DIR/skills/$s/SKILL.md" ]] || continue
      echo "- **$s** — $(skill_desc "$s")"
      echo "  → read \`rig/skills/$s.md\` and follow it."
    done
    echo
    echo "**Roles/subagents:** personas live in \`rig/agents/\` (rig-reviewer, rig-coder,"
    echo "rig-architect, rig-qa, rig-debugger). If your agent supports subagents,"
    echo "delegate to the named persona; otherwise adopt that persona's instructions"
    echo "inline. Helper scripts are in \`rig/scripts/\`; review patterns in"
    echo "\`rig/REVIEWER.md\` (set \`review.patternsFile\` accordingly)."
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

# --- Optional: Smithers durable-orchestration setup --------------------------
# Smithers (smithers.sh) is a SEPARATE, complementary tool — a crash-resistant
# AI-workflow orchestrator. Rig = conventions; Smithers = the durable engine.
# Opt in with --with-smithers; needs a JS runtime (bun preferred, else node/npx).
maybe_setup_smithers() {
  [[ "$WITH_SMITHERS" -eq 1 ]] || return 0
  echo
  echo "Smithers (durable orchestration, optional):"
  local runner extra=()
  if command -v bun >/dev/null 2>&1; then
    runner="bunx"
  elif command -v npx >/dev/null 2>&1; then
    runner="npx"; extra=(--no-install)   # bun install step needs bun; skip on npx
  else
    echo "  skip: no JS runtime (bun or node/npx) found — Smithers needs one." >&2
    return 0
  fi
  echo "  runner: $runner  (package: smithers-orchestrator — NOT 'smithers')"
  ( cd "$TARGET" && "$runner" smithers-orchestrator init --yes --no-tutorial "${extra[@]}" ) \
    || { echo "  Smithers init did not complete cleanly — see output above." >&2; return 0; }
  # Cohesion: seed Smithers' repoCommands.test from the Rig profile if both exist.
  if command -v jq >/dev/null 2>&1 && [[ -f "$TARGET/.rig/config.json" && -f "$TARGET/.smithers/smithers.config.ts" ]]; then
    local tcmd
    tcmd=$(jq -r '.test.command // empty' "$TARGET/.rig/config.json")
    if [[ -n "$tcmd" ]] && ! grep -q "test: \"$tcmd\"" "$TARGET/.smithers/smithers.config.ts"; then
      echo "  tip: set repoCommands.test = \"$tcmd\" in .smithers/smithers.config.ts to match your Rig profile."
    fi
  fi
}
maybe_setup_smithers

cat <<EOF

Done. Next:
  1. Edit $TARGET/.rig/config.json for your project (see docs/config.md).
  2. For CI workflows, see $RIG_DIR/ci/README.md (copy + parameterize by hand).
  3. Or run the 'rig-onboard' skill in your agent for the guided setup.$( [[ "$WITH_SMITHERS" -eq 1 ]] && printf '\n  4. Smithers scaffolded .smithers/ — try: %s smithers-orchestrator workflow list' "${runner:-bunx}" )
EOF
