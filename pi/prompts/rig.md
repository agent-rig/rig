---
description: Run a Rig skill, with its role delegation wired to pi-subagents
argument-hint: "<skill> [args] — e.g. review find, review fix 123, task ABC-123, debug, plan, tidy, sprint"
---

Run a Rig skill. First argument is the skill (`review`, `task`, `debug`, `plan`,
`tidy`, `spike`, `sprint`, `epic`, `issue`, `worktree`, `doctor` — a bare `rig-`
prefix is fine too); everything after it is the skill's own arguments.

## Load, in this order

1. `.rig/config.json` — the project profile. Every skill reads its knobs
   (`test.command`, `vcs.baseRef`, `tracker.provider`, `review.*`,
   `sourceScope`) instead of assuming them. If it's missing, say so and stop;
   the project hasn't been onboarded.
2. The skill itself, named `rig-<skill>`. It's an Agent Skill, so it's already
   listed in your system prompt with its path — read that `SKILL.md` **in full**
   and follow its procedure literally; it is the source of truth, not this
   template. If it isn't in the listing, look for
   `.agents/skills/rig-<skill>/SKILL.md`, then `.pi/skills/`, then
   `~/.agents/skills/`. Only if it's genuinely absent, say which skill is
   missing and stop.

## Role delegation

Rig skills name roles indirectly: "spawn `agents.reviewer`", "fan out
`agents.architect`". Resolve each to a concrete agent, then delegate:

- The agent name is `.rig/config.json` → `agents.<role>` when set, else
  `rig-<role>` (`rig-reviewer`, `rig-coder`, `rig-architect`, `rig-qa`,
  `rig-debugger` — installed in `.pi/agents/`).
- Delegate with the `subagent` tool. Give each child a **concrete, self-contained
  task**: what to inspect, which paths/refs, what to return. A child cannot see
  this conversation, so never refer to "the above" or "the plan we discussed".
- Children do not delegate further and do not manage the loop — this session is
  the orchestrator and the final decision-maker.
- `rig-architect` and `rig-reviewer` are read-only by construction (no `write`
  or `edit` tool). Keep it that way: they report, they don't fix.
- Only one writer at a time against a given worktree. Rig's own flows already
  isolate parallel work in separate worktrees (`rig-worktree`) — respect that
  boundary and pass each writer its worktree path explicitly.

## Shape of the run

- **Fixed sequence** known up front (e.g. `rig-plan`'s decompose → review, or
  `rig-task`'s architect → qa → coder → reviewer) — express it as one
  `workflowScript` so the stages are declared rather than improvised. Pass
  `async: true` when the user shouldn't be blocked.
- **Convergence loop** (`rig-review fix`, `rig-epic`'s integration passes) —
  keep this session as the loop controller: delegate one round, read the result,
  decide whether to run another. Honour the skill's own round cap
  (`review.maxRounds`, `--rounds N`) rather than inventing one, and stop early
  when a round comes back clean.
- **Read-only gate** (`rig-review find`, `rig-doctor`) — fan out fresh-context
  children in parallel where the skill asks for independent passes; each must
  re-read the repo itself rather than trusting a summary.
- Don't apply a child's every suggestion. Synthesize: blockers, fixes worth
  doing now, deferred items with a reason. If a child surfaces an unapproved
  scope or architecture decision, stop and ask the user.

**If the `subagent` tool isn't available** (pi-subagents not installed), don't
fake it and don't skip the step: read the persona file in `.pi/agents/` and adopt
it inline for that stage, announcing which role you're wearing. The skills are
written to degrade this way. `pi install npm:pi-subagents` enables real
delegation with isolated context per role.

Skill and arguments: $@
