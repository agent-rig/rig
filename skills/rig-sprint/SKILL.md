---
name: rig-sprint
description: "Plan or run a sprint of independent tickets (or ad-hoc tasks). Use 'plan <feature>' to decompose a feature into independent tickets (no integration branch — each lands on the trunk on its own). Pass ticket IDs (or task descriptions) to execute them in phased dependency order with cleanup between phases. With no args (or just 'plan'), previews the current sprint-ready queue without launching anything. Triggers on: 'sprint', 'plan sprint', 'plan this as a sprint', 'break this into tickets', 'run tickets', 'execute tickets', 'run these tickets', 'kick off tickets', 'start sprint'."
argument-hint: "[plan <FEATURE-DESCRIPTION>] | [plan] | [ticket-identifiers or task list] | (no args = preview queue)"
---

# Sprint Orchestrator

A sprint is a batch of *independent* work items that each land on the
trunk on their own. Use this when the work decomposes into pieces that
don't interleave (no shared runtime contract across siblings, no
half-migrated state if you ship one without the others). If children
do interleave, use an epic / integration-branch flow instead — same
decomposition step, plus a shared branch the children stack on.

## Configuration

Reads `.rig/config.json` (missing keys → defaults):

| Key | Default | Used for |
|---|---|---|
| `tracker.provider` | `none` | `linear` \| `github` \| `none`. Selects the ticket backend, or ad-hoc mode. |
| `tracker.team` | — | Linear team / GitHub org for list/create. |
| `tracker.project` | — | Linear project for list/create. |
| `tracker.ticketPrefix` | — | Recognize ticket IDs in `$ARGUMENTS`. |
| `tracker.githubIntegration` | `false` | If true, GitHub drives PR/merge transitions; each `/rig-task` sets only the start-of-work In Progress. |
| `vcs.baseRef` | `origin/main` | Base each ticket's branch is cut from. |
| `vcs.branchConvention` | `{user}/{ticket}-{slug}` | New-branch template. |
| `vcs.defaultBranch` | `main` | Trunk each PR targets. |
| `vcs.protectedBranchMergeQueue` | `false` | If true, merge via `gh pr merge --auto` and never pass `--rebase`/`--squash`. |
| `runtime.installCommand` / `packageManager` | `npm` | Install command inside a worktree. |
| `test.command` | `npm test` | Test step in each per-ticket implementation. |
| `sourceScope[0]` | `src` | Default codebase area to explore during decomposition. |

**Tracker modes:**
- `linear` — tickets are Linear issues; use the `mcp__claude_ai_Linear__*` tools.
- `github` — tickets are GitHub issues; use `gh issue`.
- `none` — **ad-hoc mode.** There are no ticket IDs. Treat each item in
  `$ARGUMENTS` (or each bullet the user gives) as a task *description*.
  Skip all create/list/move-ticket steps; the sprint operates directly
  on the task list, and each task's implementation opens a PR whose title
  is the task description. `plan <feature>` still decomposes into a
  numbered task list — it just prints it instead of creating tickets.

## Arguments

The user invoked this with: $ARGUMENTS

## What to do

### If the user said `plan <FEATURE-DESCRIPTION>` (decompose a feature)

Create independent work items that can each be picked up and landed on
the trunk directly — no parent epic, no integration branch.

1. **Read context.**
   - Any product/spec docs the project keeps (ask if unsure — don't
     assume a fixed path).
   - Explore the codebase to understand what already exists. Default the
     exploration scope to `sourceScope[0]` (fallback `src`).
   - **Search before creating** to avoid duplicates:
     - Linear: `mcp__claude_ai_Linear__list_issues` with `project` =
       `tracker.project`, a `query` of the feature's key nouns,
       `limit: 50` — search, don't pull the whole board; page via the
       returned cursor only if a likely match looks cut off.
     - GitHub: `gh issue list --search "<key nouns>" --state all`.
     - Ad-hoc (`none`): grep the codebase / recent branches for prior art.
2. **Sanity-check it's actually sprint-shaped (independent), not
   epic-shaped (interleaved).** If at least one child's runtime contract
   genuinely depends on another being partially complete (the middle
   state would break the trunk), stop and tell the user to use an
   epic / integration-branch flow instead.
3. **Break the feature into 3–8 discrete items,** ordered by dependency.
   No parent ticket.
4. **Materialize the items:**
   - **Linear:** `mcp__claude_ai_Linear__save_issue` per item — `team` =
     `tracker.team`, `project` = `tracker.project`, short action-oriented
     `title` ("Add X", "Wire up Y", "Implement Z"), `state: "Backlog"`,
     `priority` 2/3/4, a markdown `description` (Overview, Acceptance
     Criteria, dependency references). **Set `blockedBy` for every real
     dependency** — not optional; the phaser relies on it to group
     correctly.
   - **GitHub:** `gh issue create` per item with the same title/body;
     encode dependencies as "Blocked by #N" in the body (GitHub has no
     native blockedBy).
   - **Ad-hoc (`none`):** don't create anything — just produce the
     numbered task list with an explicit "depends on #k" note per item.
5. **Show the user a summary table** of what was created (or the task
   list, in ad-hoc mode):

   | ID / # | Title | Priority | Depends On |
   |--------|-------|----------|------------|

6. **Hand off.** End with: *"Run `/rig-sprint <ID1> <ID2> ...` (or paste the
   task list back) to batch-execute these in phased dependency order."*
   Don't move tickets to Todo or auto-run — the user picks the entry point.

### If the user said `plan` (no description) — or passed no arguments at all

Preview-mode for the existing sprint queue. Neither launches work; they
show what's ready to run and wait for the user to pick items or kick off
the sprint.

1. Fetch ready work:
   - **Linear:** `mcp__claude_ai_Linear__list_issues` with `project` =
     `tracker.project`, state `"Todo"`, `limit: 100` (page via cursor if
     truncated). Also check `"In Progress"` for in-flight work.
   - **GitHub:** `gh issue list --state open` (optionally filtered by a
     "ready" label the repo uses).
   - **Ad-hoc (`none`):** there is no queue — say so and ask the user to
     supply the task list.
2. Show the user: which items are ready, a suggested phase grouping based
   on dependencies (`blockedBy`/`blocks` relations, or "Blocked by #N"
   text), and estimated scope per phase.
3. Ask the user to confirm before launching.

### If the user specified ticket identifiers (or a task list)

1. **Resolve the items.**
   - Detect ticket IDs by `tracker.ticketPrefix`. For Linear, fetch each
     with `mcp__claude_ai_Linear__get_issue`; for GitHub,
     `gh issue view <number>`. In ad-hoc mode, each argument/bullet is a
     task description — no fetch.
2. **Determine phases:**
   - Group items with no inter-dependencies into the same phase.
   - Items that depend on other specified items go in a later phase.
   - Use `blockedBy`/`blocks` relations, "Blocked by #N" text, or the
     description clues (ad-hoc: the "depends on #k" notes) to order them.
3. **Show the proposed phases** to the user for confirmation.
4. **Mark items in-flight (tracker only):**
   - **Guard — `tracker.githubIntegration`:** if true, skip the bulk move
     here — each `/rig-task` sets its own item to "In Progress" at start
     (Step 1), and GitHub advances In Review / Done from PR events.
   - Otherwise, move every item in the sprint to Todo (Linear:
     `save_issue` with `state: "Todo"`).
   - Ad-hoc mode: nothing to move.
5. **Execute each phase.** Within a phase, items are independent and can
   run in parallel; whichever PR lands second rebases on the trunk. For
   **each item** in the phase, run **`/rig-task`** (passing the ticket ID,
   or the task description in ad-hoc mode) and act on its returned outcome
   — only a `clean` review is merge-green; anything else stops for a human.
   Move to the next phase only after **every** item in the prior phase has
   its PR merged.
6. **Between phases and at the end,** run `/rig-tidy` to audit the merged
   commits for dead code, duplicates, and stale comments before building
   on top of them.

## Implementing each item

Each item is implemented by the **`/rig-task`** skill — a self-contained
`spec → worktree → TDD → pre-PR review → open PR → review-bot loop`
orchestrator. Sprint does not reimplement that loop; it just sequences the
items and calls `/rig-task` per item (Step 5 above), reading the config
knobs (`tracker.*`, `vcs.*`, `test.*`, `review.*`) the same way.

`/rig-task` never auto-merges and returns an outcome string; sprint uses
it to gate phase progression (merge only on `clean`, run `/rig-tidy`
between phases). See the `/rig-task` skill for the full per-item cadence.
