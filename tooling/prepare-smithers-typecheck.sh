#!/usr/bin/env bash
# Materialize the `agents` seam so `tsc` can typecheck the smithers/ templates.
#
# The workflow templates import `providers` from `../agents` (i.e. smithers/agents.ts),
# which ships as `agents.example.ts` (copy-to-activate) and re-exports two thin
# harness wrappers from `./agents/{claude-code,codex}` that a consumer supplies.
# None of that exists in this source repo by design — so before a typecheck we
# generate the seam from the example + stub the two wrapper modules with the
# package's own agent classes. The generated files are gitignored (see .gitignore)
# and are NOT vendored by install.sh; they exist only to give `tsc` a resolvable
# module graph.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.."

cp smithers/agents.example.ts smithers/agents.ts
mkdir -p smithers/agents
cat > smithers/agents/claude-code.ts <<'EOF'
// Generated stub for typecheck (see tooling/prepare-smithers-typecheck.sh).
export { ClaudeCodeAgent } from "smithers-orchestrator";
EOF
cat > smithers/agents/codex.ts <<'EOF'
// Generated stub for typecheck (see tooling/prepare-smithers-typecheck.sh).
export { CodexAgent } from "smithers-orchestrator";
EOF
echo "prepared: smithers/agents.ts + smithers/agents/{claude-code,codex}.ts (gitignored)"
