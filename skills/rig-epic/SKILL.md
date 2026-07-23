---
name: rig-epic
description: "Plan and run a multi-ticket epic: decompose a feature into parent + child items and stack PRs on a shared integration branch instead of landing each on main. Use when children interleave (one item's runtime contract depends on another's incomplete state) — stacking keeps each child PR reviewable without temporarily breaking main, then squashes to main once. Triggers on: 'epic', 'plan epic', 'plan this as an epic', 'break this into an epic', 'start epic', 'integration branch', 'stack PRs', 'finish epic'."
argument-hint: "status | plan <FEATURE> | start <PARENT> | next | run | review [<PARENT>] | finish [<PARENT>] [--merge] | prune"
---

# rig-epic — integration-branch workflow

For multi-item arcs where landing each item directly on the trunk would
temporarily break the runtime contract, stack child PRs on a shared
**integration branch** and squash that branch into the trunk as one PR at the
end. Each child PR is reviewed *as the step it actually is*; the trunk-bound
delivery is one squashed rebase.

## Configuration

Reads `.rig/config.json` (defaults in parentheses):

- `tracker.provider` — `linear` | `github` | `none` (`none`). How parent/child
  items are stored. `none` → items live only in the epic **state file** (below);
  no tracker calls.
- `tracker.team` / `tracker.project` / `tracker.ticketPrefix` / `tracker.githubIntegration`.
- `vcs.baseRef` (`origin/main`), `vcs.defaultBranch` (`main`),
  `vcs.protectedBranchMergeQueue` (`false`).
- `sourceScope[0]` — where to explore during `plan`.
- `agents.architect` / `agents.reviewer` (default `rig-<role>`) — for the
  fresh-context `review` panel.

Delegates to `/rig-task` (per child), `/rig-worktree` (checkouts), `/rig-review`
+ `/rig-review fix` (the combined-diff review), `/rig-tidy` (optional).

### Epic state file (replaces any external memory)

Each active epic is tracked in a repo-local JSON file at
**`.rig/epics/<integration-branch>.json`**:

```json
{
  "parent": "ABC-42 or a slug in tracker=none",
  "parentTitle": "…",
  "integrationBranch": "abc-42-<slug>",
  "whyEpic": "which children interleave and why",
  "children": [
    { "id": "ABC-43", "title": "…", "blockedBy": [], "branch": null, "status": "todo|merged" }
  ]
}
```

This is the single source of truth `next`/`run`/`review`/`finish`/`prune` read.
Add `.rig/epics/` to `.gitignore` (it's transient coordination state). Parent
inference (when `<PARENT>` is omitted): if exactly one `.rig/epics/*.json`
exists, use it; if zero or many, ask.

**Intent banner:** every invocation MUST print one line first — mode, what
branch PRs target, what it won't do:

```
rig-epic: <subcommand> — <action>. PRs target <branch>. Will not <thing>.
```

## `status` (default, report-only)

Read the epic state file(s). Report: integration branch + commits ahead of
`vcs.baseRef`; open child PRs (`gh pr list --base <integration-branch>`) and
their state; each child's tracker status (if a tracker); leftover merged/deleted
worktrees (suggest `/rig-epic prune`); and a one-line recommendation (`open child
PR X`, `ready for /rig-epic next`, or `ready for /rig-epic finish`). Modify
nothing; spawn nothing.

## `plan <FEATURE>`

Decompose a feature into a parent + 3–8 children, write the state file, then
chain into `start`.

Use this only when the work is genuinely epic-shaped (children interleave —
at least one child's runtime contract depends on another being partially
complete). If the items are independent and each can land on the trunk alone,
stop and tell the user to run `/rig-sprint plan` instead — same decomposition,
no integration branch.

### Procedure
1. **Read context.** Product/spec docs if the project has them (ask if unsure);
   explore the codebase (`sourceScope[0]`) to see what exists. If a tracker is
   configured, search it for near-duplicate items first.
2. **Sanity-check it's an epic** (per the interleave test above). If not → send
   to `/rig-sprint plan`.
3. **Create the parent.**
   - `tracker: linear`/`github` → create the parent item (team/project from
     config); description covers Overview, why-it's-an-epic, and the planned
     children.
   - `tracker: none` → the parent is a slug + title recorded in the state file only.
4. **Create each child** with its dependency edges.
   - Small enough for one agent session (1–3 files); concrete, testable
     acceptance criteria; foundational work first.
   - **Record `blockedBy` for every real dependency** — this is what `next`
     reads to pick the next unblocked child. Without it the pick falls back to
     declaration order and gets interleaved epics wrong.
   - Tracker mode: set the tracker's native parent/blocked-by relations *and*
     mirror them into the state file. `none`: state file only.
5. **Show a summary table** (ID · Title · Depends On).
6. **Chain into `start <PARENT>`** — `plan` is plan-and-start; don't stop to ask.
7. **Stop after `start`.** Report the integration branch, the children, and the
   next step (`/rig-epic next` for one, `/rig-epic run` for the loop). Never
   auto-start `run` — execution is an explicit opt-in.

## `start <PARENT>`

Pre-flight: `git fetch origin`; confirm the parent and at least one child exist
(in the tracker, or as arguments for `none`).

1. **Integration branch name:** `<parent-slug>-<title-slug>` (kebab, e.g.
   `abc-42-agent-as-definition`).
2. **Cut the integration branch from `vcs.baseRef`** without a local checkout:
   ```bash
   git fetch origin
   git push origin <vcs.baseRef>:refs/heads/<integration-branch>
   ```
   Non-destructive. If the branch already exists, leave it (never overwrite —
   could destroy in-flight work).
3. **Write `.rig/epics/<integration-branch>.json`** (schema above) with the
   parent, why-epic, and every child + `blockedBy`. This is what makes each
   `/rig-task <child>` target the integration branch instead of the trunk.
4. **If a tracker is configured**, add an "Integration branch: target
   `<integration-branch>`, not the trunk" note to each child so the next agent
   doesn't re-read this skill. Respect `tracker.githubIntegration` — don't
   hand-transition states.
5. **Report** the branch, the children, and the next step.

## `next` (single child)

1. Resolve the active integration branch (one expected; ask if many).
2. **Pick the next unblocked child:** the first not-done child whose `blockedBy`
   are all merged into the integration branch. State the pick + reasoning in the
   banner.
3. **Fast-forward the integration branch over the previous child's tip** (if
   any):
   ```bash
   git fetch origin
   git push origin origin/<previous-child-branch>:refs/heads/<integration-branch>
   ```
   This auto-closes the previous PR as MERGED (head == base). Safe to re-run.
4. **Run `/rig-task <CHILD> --base <integration-branch>`** — the `--base`
   override makes the child's worktree branch from, and its PR target, the
   integration branch instead of the trunk. Run it one-shot (start→finish) so it
   returns a single outcome string for the merge gate.
5. **Merge gate — only `clean` is merge-green:**
   - `clean` → merge the child PR **into the integration branch**:
     `gh pr merge <N> --rebase --auto --delete-branch` (the integration branch
     is not the protected trunk, so an explicit rebase-merge is fine here).
     Record the child `merged` + its branch in the state file.
   - anything else (`actionable`/`timeout`, or a tracker-parked state) → stop.
     Surface the outcome, the PR URL, and any reviewer summary. Wait for the
     user; don't retry a parked review.

`next` does exactly one child. Use `run` for the loop.

## `run`

Loop `next` until no unblocked child remains:
```
while an unblocked child exists:
  run /rig-epic next
  if it stopped without merging (outcome ≠ clean) → stop, hand back
  else → re-evaluate unblocked children
```
When the queue empties, report "epic ready for `/rig-epic finish`."

## `review [<PARENT>]`

Run after the last child merged into the integration branch, before `finish`.
Per-PR review (`/rig-review` inside each `/rig-task`) sees each child in
isolation; this sees the *combined* shape and the *simplification* only visible
once everything is in. Fresh-context sub-agents (input = the squashed diff +
child PR titles) can't inherit the implementer's remembered rationalizations.

**Run before `prune`** — the review sub-agents need a working checkout; reuse a
child worktree if one still exists (avoids a fresh install + env re-symlink).

1. Resolve the integration branch; `git fetch origin`.
2. **Ensure an integration-branch worktree** (`$WT`). Reuse a merged-child
   worktree fast-forwarded to the integration tip, else create one with
   `/rig-worktree` (`--base <integration-branch> --reuse`).
3. **Fan out three sub-agents in parallel** (one message, three `Agent` calls),
   each `cd`-ing into `$WT` with the integration tip checked out:
   - **Lens 1 — Simplification (`agents.architect`):** diff
     `git diff <vcs.baseRef>...HEAD`; child PR list via `gh pr list --base
     <BR> --state merged`. Mandate: find abstractions to collapse, helpers one
     PR added that another PR's final shape made redundant, config knobs nobody
     sets, code paths the combined diff made dead, one-caller types. Concrete
     deletions/merges, file:line, highest-impact first. Skip correctness.
   - **Lens 2 — Cross-PR correctness (`agents.reviewer`):** walk the project's
     review-pattern catalog (`review.patternsFile`) against the *combined* diff.
     Per-PR review already ran; catch interactions only visible at the merged
     shape (PR-A's helper vs PR-D's stale caller; PR-B removed a knob PR-F still
     reads). P0/P1/P2 with file:line + category.
   - **Lens 3 — Dead code & stale refs (`agents.reviewer`):** for every symbol
     the diff *added*, is it called elsewhere? For every symbol *removed*, grep
     the tree (workflows, manifests, IaC, scripts, docs) for residual refs.
     Report with file:line.
4. **Consolidate** — dedupe, produce one P0/P1/P2 list grouped by lens, print
   counts.
5. **Triage:**
   - 0 items → `clean — ready for /rig-epic finish`, stop.
   - findings → ask via `AskUserQuestion`: `apply now` / `skip and finish
     anyway` (downgrade to follow-ups) / `pause`. On `apply now`, run
     `/rig-review fix --source local` in `$WT` (spawns `agents.coder`,
     re-reviews to clean), commit + `git push origin <integration-branch>`,
     re-run `review` once to confirm convergence.
6. **Outcome string** (for `finish`): `clean — …` / `applied — …` / `paused — …`.

## `finish [<PARENT>] [--merge]`

Squashes the whole integration branch into a single PR to the trunk. **Default:
open the PR and stop** — this is the one PR to eyeball.

**`review` is a hard gate.** `finish` always runs `review` first; the squash PR
opens only on `clean` or `applied`. On `paused`, stop and wait.

1. **Run `review` (gate)** inline; branch on its outcome (`clean`/`applied` →
   proceed; `paused` → stop and print pending findings).
2. **Refresh & rebase if needed.** `git fetch origin`; list
   `git log <vcs.baseRef>..origin/<integration-branch> --oneline`. If the trunk
   moved, rebase the integration branch onto it first
   (`git rebase <vcs.baseRef>` on a local copy, then
   `git push --force-with-lease origin <local>:<integration-branch>`).
3. **Open the final PR** to `vcs.defaultBranch` with a title referencing the
   parent and a body summarizing all children. In a tracker with a closes-verb
   (`Fixes <PARENT>` / `Closes #<n>`), include it so the parent auto-closes.
4. **Merge behavior:**
   - default → stop, print the PR URL (squash-to-trunk is the human gate).
   - `--merge` → `gh pr merge <N> --squash --delete-branch`, adding `--auto` if
     CI gates it. **If `vcs.protectedBranchMergeQueue` is true**, use
     `gh pr merge <N> --auto` with **no** method flag (the queue's method wins).
5. Don't hand-transition the parent's tracker state when
   `tracker.githubIntegration` is true — the closes-verb handles it.
6. **Delete the epic state file** `.rig/epics/<integration-branch>.json` (the
   work is on the trunk now).
7. **Offer local verification.** Ask whether to verify the epic on a local build
   before moving on. If the project ships a local-run/QA skill, invoke it **from
   the integration-branch worktree** (`cd` there first — don't accidentally serve
   the trunk). Otherwise point the user at the project's run instructions.

## `prune`

Remove integration-branch worktrees whose branches are merged (auto-closed PRs)
or gone on origin. Epic-specific *policy* here; the teardown delegates to
`/rig-worktree rm` so the skip-if-dirty safety lives in one place.

1. **List candidates:** `git worktree list --porcelain`; for each child-branch
   worktree, check whether its PR is `MERGED`/`CLOSED` or its remote tracking
   branch is gone (`/rig-worktree list` prints this table — reuse it).
2. **Keep-one-for-review rule:** until `finish` lands the squash PR, keep one
   usable worktree (most recent merged child, or an explicit integration-branch
   worktree) so `review` doesn't pay a fresh install + env re-symlink. After
   `finish`, all are fair game.
3. **Remove the rest** via `/rig-worktree rm` (dirty worktrees are skipped, not
   removed). Report removed / kept (+why) / skipped (+reason).

## Gotchas

- **Long-lived integration branches drift.** If the trunk moves during the epic,
  rebase the integration branch periodically — catching drift mid-epic beats a
  painful conflict at `finish`.
- **Don't force-push the integration branch except when rebasing onto the
  trunk.** In-flight child PRs are based on its tip; a rewrite breaks them. The
  FF-between-children pattern advances the branch without rewriting history.
- **Auto-closed PRs aren't reviewed.** FF'ing over a child's tip closes its PR as
  MERGED without a gate — the real review is `finish`'s combined squash PR. If a
  child truly needs its own review, hold off FF'ing and let the user merge it.
- **State file carries the *why*.** The integration branch carries the code; the
  `.rig/epics/*.json` note carries why-it's-an-epic, the dependency chain, and
  what got descoped. Future sessions shouldn't re-derive the plan.
- **Respect the tracker integration.** When `tracker.githubIntegration` is true,
  don't hand-transition child/parent states to In Review / Done — the branch +
  closes-verb drive those. (Each child's start-of-work "In Progress" is set by
  its own `/rig-task`, Step 1 — GitHub can't see local work before a PR.)
