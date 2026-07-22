---
name: rig-task
description: "Implement one unit of work end-to-end — from a tracker issue OR an ad-hoc description: spec review, TDD (RED→GREEN→REFACTOR), pre-PR self-review, open a PR, then drive the review-bot loop to clean. Runs start→finish in one shot by default; `start`/`finish` are optional phases for pause/resume. Sibling to /rig-epic (one unit vs many). Never auto-merges. Triggers on: 'implement', 'implement this', 'work on', 'pick up', 'start task', 'start <ISSUE>', 'finish task'."
argument-hint: "[start|finish] [<issue-id> | \"<description>\"] [--local] — no subcommand runs start→finish in one shot. e.g. 'start ABC-18', 'start \"add dark mode\"', 'finish'."
---

# rig-task — implement one unit of work end-to-end

Take a single unit of work — a tracker issue **or** an ad-hoc "implement this"
with no issue filed — code it test-first, open a PR, drive it to a clean review,
and hand back. **Never auto-merges.** This is the orchestrator over the kit's
building blocks: it delegates isolation to `/rig-worktree`, review to
`/rig-review`, and the fix loop to `/rig-review fix`, so each concern lives in
one place.

It's the single-unit sibling of `/rig-epic` (one unit vs many interleaved), and
mirrors its lifecycle: **`start`** gets you to an open PR, **`finish`** drives
the review to clean. By default a bare invocation runs both in one continuous
session — the phases exist for when you want to open the PR, let CI / the review
bot run, and `finish` later. `/rig-sprint` calls this once per item.

## Configuration

Reads `.rig/config.json` (defaults in parentheses):

- `tracker.provider` — `linear` | `github` | `none` (`none`). Selects how the
  spec is loaded and the PR is linked. `none` → the item is an ad-hoc task
  description; no ticket calls.
- `tracker.ticketPrefix` — e.g. `ABC-`; used to infer a ticket from the branch.
- `tracker.githubIntegration` — when `true`, do **not** hand-transition tracker
  state; the PR link drives it. When `false`/absent, you may move states.
- `tracker.labelMapFile` (`.claude/label-mapping.md`) — label source of truth.
- `vcs.baseRef` (`origin/main`), `vcs.defaultBranch` (`main`),
  `vcs.branchConvention` (`{user}/{ticket}-{slug}`),
  `vcs.protectedBranchMergeQueue` (`false`).
- `runtime.packageManager` / `runtime.installCommand` — passed to `/rig-worktree`.
- `test.command` (`npm test`), `test.integrationCommand`, `test.e2eCommand`.
- `review.patternsFile` (`.claude/REVIEWER.md`), `review.bot`
  (`none`), `review.botRetrigger`, `review.maxRounds` (`5`).
- `agents.architect` / `agents.qa` / `agents.coder` / `agents.reviewer`
  (default `rig-<role>`) — the registered agent names for each role.

**Unconfigured fallback:** with no profile, this runs with tracker `none` (ad-hoc
task), `npm test`, base `origin/main`, and a local-only review loop.

## Subcommands (phases)

`$ARGUMENTS` begins with an optional phase, then a target:

- **(no phase)** — run `start` then `finish` in one continuous session. The
  common case: "implement this."
- **`start [<issue-id> | "<description>"]`** — Steps 1–5: load/decide the spec,
  set up a worktree, TDD to green, pre-PR self-review, and **open the PR**. Then
  stop. Use to kick a unit off and let CI / the review bot run while you move on.
- **`finish [<issue-id | PR#>]`** — Steps 6–7: resolve the open PR (from the arg,
  the current branch, or the single open PR for this unit), drive the review-bot
  loop to a terminal state, and hand back. Resumes a unit `start` (or a teammate)
  opened.

**Target resolution:**
- An `<issue-id>` matching `tracker.ticketPrefix` (and tracker ≠ none) → load the
  spec from the tracker.
- A quoted `"<description>"` (or tracker = none) → **ad-hoc**: the description is
  the spec; no tracker record required. Optionally offer to file an issue at the
  end.
- Omitted → infer from the current branch's `{tracker.ticketPrefix}<N>` token;
  else ask.

`--local` — in the `finish` phase, force the local `/rig-review fix` loop even if
a cloud auto-fix workflow is enabled (see Step 6).

`--base <ref>` — branch the worktree from, and target the PR at, `<ref>` instead
of `vcs.baseRef`. A caller like `/rig-epic` passes the integration branch here so
the child stacks on it rather than the trunk.

Print the resolved unit + phase as the first output line, e.g.
`rig-task start: ABC-369 (from branch alice/abc-369-...)` or
`rig-task start: ad-hoc "add dark mode"`.

---
The steps below are grouped into the two phases. **Steps 1–5 are `start`;
Steps 6–7 are `finish`.** A bare `rig-task` runs all of them in order.

## Step 1 — Load the spec and set up a worktree

1. **Load the spec.**
   - `tracker: linear` → fetch the issue via the Linear MCP `get_issue`; the
     description + acceptance criteria are the spec. **Do not** set state to
     "In Progress" when `tracker.githubIntegration` is true — the branch/PR
     drives it.
   - `tracker: github` → fetch the issue via `gh issue view`.
   - `tracker: none` → the argument/task description is the spec; if it's a
     one-liner, ask the user to expand the acceptance criteria.
   Restate the acceptance criteria to yourself before coding.
2. **Set up an isolated checkout via `/rig-worktree`** (don't inline `git worktree
   add` — the skill owns fetch-before-branch, env symlinks, and per-worktree
   install). Branch name:
   - `tracker: linear` and the payload carries a suggested per-user branch name
     (`gitBranchName`) → use it **verbatim** (it's what a tracker↔GitHub
     integration matches on for auto-state).
   - Otherwise build from `vcs.branchConvention`: `{user}` = git user, `{ticket}`
     = the ID (or a kebab slug of the task in ad-hoc mode), `{slug}` = short
     kebab of the title.
   Base from `vcs.baseRef`. `cd` into the printed worktree path (`$WT`); use it
   as `{worktree-path}` in the agent prompts below.

   **Name the session** so a background-job list reads as the work, not the
   prompt (Claude-Code-only; no-ops elsewhere). Pass `--name` through to
   `/rig-worktree` — `"FEAT: <title> (<ticket>)"` for new behavior/bug fixes
   (conventional-commit `feat:`/`fix:`), `"CHORE: <title> (<ticket>)"` for
   maintenance (`chore:`/`refactor:`/`test:`/`docs:`). Add `--skip-if-prefix
   "EPIC:"` so an epic label set by `/rig-epic` wins when this runs as a child.

## Step 2 — Spec review

Launch the **architect** and **qa** agents in parallel (names via `agents.*`):

- **architect**: "Review this spec for implementability. Identify ambiguities,
  missing acceptance criteria, files that need to change, and a suggested
  implementation order. Spec:\n{title}\n\n{description}"
- **qa**: "Review this spec from a testing perspective. What test cases are
  needed? Are the acceptance criteria testable? What edge cases matter?
  Spec:\n{title}\n\n{description}"

If either flags something that should be fixed before coding, clarify it — and,
in tracker mode, update the item's description with the clarification and tell
the user what changed.

## Step 3 — RED: tests first

Launch **qa** to write tests against the spec, *before* any implementation:

- **qa**: "Write tests for this item. Cover every acceptance criterion + the
  edge cases the architect flagged. Don't stub or comment out — the tests must
  compile and fail for the right reason (missing implementation), not a syntax
  error. Worktree: {worktree-path}. Match the project's test framework and
  colocation conventions.\n\nSpec:\n{title}\n\n{description}\n\nArchitect
  notes:\n{architect_output}"

Run the suite from the worktree: `cd "$WT" && <test.command>`.

**Verify red.** The new tests must fail with a message that reflects the missing
behavior (e.g. "expected X, got undefined" / "not-yet-implemented symbol"). A
new test that passes immediately was pinning existing behavior — send it back to
qa. A syntax error is a qa bug; fix it before moving on.

## Step 4 — GREEN: minimum implementation

Launch **coder** with the failing tests as the spec:

- **coder**: "Implement {item} to make the failing tests pass. Worktree:
  {worktree-path}. Explore the affected files first and prefer *extending or
  reusing* existing code over a parallel implementation. Make the minimum change
  — no features not required by a test.\n\nSpec:\n{title}\n{description}\n\n
  Architect notes:\n{architect_output}\n\nFailing tests:\n{test_output}"

Re-run the suite. If still red, send coder a fix iteration with the current
failures. **Max 3 iterations**; if still red after 3, stop and surface to the
user — the spec is likely wrong or there's an unstated constraint. If
implementing exposes a missing edge case, add that test first (loop back to RED
for it) rather than piling untested behavior into GREEN.

## Step 4.25 — REFACTOR (optional, only while green)

If the GREEN code has obvious duplication, awkward naming, or a helper that
wants extracting, spawn **coder** once more — "no new behavior, tests stay
green" — and re-run the suite. Skip if the code is already clean.

## Step 4.5 — Pre-PR self-review (gate before push)

The point: pre-empt the PR review bot — every finding caught here is one you
don't pay a round-trip on. Delegate so the gate lives in one place:

1. **Find.** Run `/rig-review {vcs.baseRef}` for this item (in
   `{worktree-path}`). It walks `review.patternsFile` against
   `git diff {vcs.baseRef}...HEAD` and returns a triaged P0–P3 list.
2. **Classify and fix:**
   - **No P0/P1** → proceed to Step 5 (P2/P3 are fine to ship; report them).
   - **Any P0/P1** → run `/rig-review fix --source local --base {vcs.baseRef}` in
     `{worktree-path}`. It spawns **coder** per finding, re-runs `/rig-review`,
     and loops to clean (max `review.maxRounds`). If still P0/P1 after the last
     round it returns `unresolved` — stop, surface to the user, don't push.
3. Report the final state before pushing, e.g. `tests: green, review: 0 P0/P1 +
   2 P2 (deferred)`.

## Step 5 — Push and open the PR

1. Commit all changes with a message referencing the item.
2. Push the branch.
3. Open a PR (`gh pr create`) targeting `vcs.defaultBranch` (or the base from
   Step 1 if a stacked base was used):
   - Title carries the item ID where a tracker is used (e.g. `feat(ABC-18):
     …`), so it's visible in the PR list, not just the body.
   - Body includes: a summary; the tracker link (`Fixes ABC-18` for Linear /
     `Closes #<n>` for GitHub — the keyword that auto-links and, with
     `tracker.githubIntegration`, auto-transitions state); a test plan; and an
     **`## Architecture`** section stating any new abstraction/package/
     dependency/migration or core-domain touch and **why existing code wasn't
     reused** (write "No architectural change." otherwise).
4. In tracker mode, link the PR to the item (Linear: `create_attachment` with
   the PR URL — **not** `save_issue` when `githubIntegration` is true). Ensure
   the item's labels match `tracker.labelMapFile` if that file exists.
5. Capture the PR number for Step 6.

**Do NOT `gh pr merge` here.** This skill never auto-merges. (When invoked by
`/rig-sprint`, the caller decides merge based on the review outcome.) If the project
ships a PR-labeler workflow, don't hand-add PR labels — it applies them.

---
## ── `finish` phase (Steps 6–7) ──

When resuming via `rig-task finish` (rather than a one-shot run), first
**re-establish context**: resolve the open PR and its worktree from the target
arg / current branch / the single open PR for this unit, and `cd` into that
worktree before continuing.

## Step 6 — Review-bot loop: watch (default) or drive (`--local`)

- **`review.bot: none`** → nothing to do; the Step 4.5 local gate was the whole
  review. Go to Step 7.
- **A cloud auto-fix workflow is enabled** (the project installed
  `ci/workflows/auto-review-fix.yml` and its enable marker) and `--local` was
  **not** passed → **watch**: do not fix or push. Poll the PR (~60s intervals,
  up to ~30 min) until the bot's review reaches a terminal state and report it.
  Running a local driver alongside a cloud one collides (both push, both
  re-trigger), so only watch here.
- **Otherwise (drive)** → delegate to **`/rig-review fix <PR>`**. It owns the bot
  protocol for `review.bot` (poll + classify the bot's review, fix via
  **coder**, commit, push, re-trigger via `review.botRetrigger`), up to
  `review.maxRounds`. Take its returned outcome as this step's result:
  - `clean` — reviewed with no actionable issues (merge gates take over).
  - `actionable` — still has feedback after the last round; left for a human.
  - `timeout` — bot didn't respond in time; left for a human.

Only `clean` is merge-green; everything else stops for a human.

## Step 7 — Hand back

Print the final outcome line and the PR URL. Don't auto-merge. Don't
hand-transition tracker state when `tracker.githubIntegration` is true.

If invoked by `/rig-sprint`, **return the outcome string** so the caller can decide
whether to merge, and skip any local-QA offer (the caller makes it once).

## Error handling

- Item can't be loaded/fetched → tell the user immediately.
- Branch already exists → ask whether to continue on it or start fresh.
- Test command times out or crashes (not just failures) → report and stop
  before opening a PR.
- `gh pr create` fails because a PR already exists → capture that PR's number
  and skip to Step 6.

## Env files in worktrees

A worktree is a fresh checkout — gitignored env files aren't carried over, and a
missing secret often reads as a flaky/timeout test failure. Step 1's `/rig-worktree`
setup symlinks gitignored env files from the main repo into the worktree before
any command runs. To re-link by hand, re-run the worktree setup with `--reuse`.
