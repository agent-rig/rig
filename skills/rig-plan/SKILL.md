---
name: rig-plan
description: "Turn a written spec or PRD into a reviewed backlog. Reads a spec file, decomposes it into work — deciding per chunk whether it's an epic (interleaved, shared integration branch), a sprint (independent tickets), or a single ticket — shows the plan for approval, then materializes the tickets on the tracker + board with dependencies and shape labels. Does NOT start work: execution is handed to rig-epic / rig-task / rig-sprint. Triggers on: 'plan', 'rig-plan', 'break down the spec', 'turn this spec into tickets', 'backlog from spec', 'plan the work', 'decompose the PRD', 'plan from SPEC.md'."
argument-hint: "[spec-file] [--section <name>] [--yes] — e.g. 'SPEC.md', 'specs/prd.md --section \"Milestone 0\"'"
---

# Spec → backlog planner

Turn a written spec into a **reviewed plan** and then a **materialized backlog**.
This is the front door for spec-driven work: you iterate on the spec, `rig-plan`
proposes the ticket structure, you approve it, and it creates the tickets. It
does **not** write code or cut branches — execution is `/rig-epic` and
`/rig-task`.

Unlike a fixed "epic breakdown," rig-plan is **shape-agnostic**: it decides, per
chunk of the spec, whether the work is an epic, a sprint, or a single ticket.

## Configuration

Reads `.rig/config.json` (defaults in parentheses):

- `tracker.provider` — `linear` | `github` | `none` (`none`). Where tickets are
  created. `none` → the plan is produced and written to a local file only.
- `tracker.shapeLabels` — GitHub-only labels applied at creation (`epic` /
  `sprint`) so a board / dispatcher can tell shapes apart.
- `tracker.board` — GitHub Projects v2 identity; when set, created tickets are
  added to the board via the `rig-tracker` adapter.
- `sourceScope[0]` — the codebase area to sanity-check feasibility against.
- `agents.architect` (default `rig-architect`) — drives the decomposition.
- `style.guideFile` (`.claude/STYLE.md`) — how the plan and every ticket body
  it materializes are written.

Delegates ticket creation to `/rig-epic` (epic chunks), `/rig-sprint` (sprint
chunks), and `/rig-issue` (singletons). Hands execution to `/rig-epic start` /
`/rig-task`.

## Arguments

- `[spec-file]` — path to the spec (default: first of `SPEC.md`, `specs/prd.md`,
  `docs/prd.md` that exists).
- `--section <name>` — plan only one section/milestone (match a heading). Good
  for "just plan Milestone 0 for now."
- `--yes` — skip the approval gate and materialize directly. Use only when the
  plan is trusted; the default is to STOP for review.

## Procedure

1. **Resolve** config + the spec file. If none is found, ask for the path. Read
   the whole spec (or just the `--section`).

2. **Decompose — fresh context, `agents.architect`.** Read the spec against
   `sourceScope[0]` to ground feasibility, then produce a flat list of **units**
   and assign each a **shape** using the interleave test:
   - **epic** — several pieces that interleave: one piece's runtime contract
     depends on another's incomplete state, or shipping one alone half-migrates
     the system. These want a shared integration branch (`/rig-epic`).
   - **sprint** — several pieces that are independent: each lands on the trunk on
     its own (`/rig-sprint`).
   - **ticket** — a single self-contained unit (`/rig-task` / `/rig-issue`).

   Record `blockedBy` edges within each epic/sprint. A milestone with one clear
   dependency chain is an epic; a bag of parallel wins is a sprint. Keep units
   small enough for one agent session (concrete, testable acceptance criteria).

3. **Present the plan for review — then STOP** (unless `--yes`). Show a tree:
   each milestone/section → its shape → its tickets (`title · shape · blockedBy`).
   This is the moment the human reviews the **plan**, not the keystrokes. Offer
   to adjust. **Create nothing until approved.**

   A plan a human can't skim is a plan they can't approve. Write it to
   `style.guideFile` (default `.claude/STYLE.md`): recommendation first, then the
   tree, then the tradeoffs you rejected and why. Ticket titles are imperative
   outcomes; acceptance criteria are testable. Flag anything you need settled
   with **Decision needed:**.

4. **Materialize — on approval — without starting.** For each chunk:
   - **epic** → create the parent + children following `/rig-epic plan`'s
     creation steps (parent gets `shapeLabels.epic`; children carry their
     `blockedBy`), but **stop before `start`** — do not cut an integration
     branch. Record it in `.rig/epics/<slug>.json` as planned-not-started.
   - **sprint** → create the independent items following `/rig-sprint plan` (each
     gets `shapeLabels.sprint`).
   - **ticket** → `/rig-issue create`.

   On `tracker: github` with `tracker.board`, add every created issue to the
   board and leave it in the backlog/Todo column, via the `rig-tracker` adapter:
   `<TRACKER> add-to-project <issue#>` where `<TRACKER>` = `.rig/rig-tracker` if
   executable else `<RIG_DIR>/scripts/rig-tracker.sh`. `tracker: none` → write
   the plan tree to `.rig/plan.md` instead of creating tickets.

5. **Report + hand off.** Print what was created (IDs + the board link) and the
   next step per shape: `/rig-epic start <PARENT>` (or `run`) for epics,
   `/rig-task <id>` for a single ticket, `/rig-sprint <ids>` for a sprint.
   rig-plan's job ends at a **reviewed, materialized backlog**; execution is
   those skills.

## Notes

- **Plan, don't start.** rig-plan never writes code or cuts branches — that is
  what keeps the review gate meaningful: you approve a backlog, then choose what
  to run and when.
- **Re-runnable.** Re-running against an updated spec proposes only the new or
  changed units; match by title / existing tracker item so it won't duplicate
  tickets that already exist.
- **Degrades.** `tracker: none` produces `.rig/plan.md` (the same tree) so the
  plan is still useful with no tracker at all.
