---
name: rig-sync
description: "Keep a repo in sync with its spec — the terraform loop for code. Treats the spec as desired state and the code as actual state, computes the drift between them (both directions), and reconciles it. `plan` (default): read-only drift report — what the spec demands that the code lacks, and what the code has that the spec doesn't. `apply`: reconcile the actionable drift through a pluggable sink — an ephemeral Smithers workflow (default), a tracked milestone of tickets, or report-only — and it never edits product code directly. Triggers on: 'rig-sync', 'sync the repo to the spec', 'spec sync', 'spec drift', 'drift between spec and code', 'reconcile spec and code', 'is the code still in sync with the spec', 'what changed vs the spec', 'terraform for code', 'plan the spec drift'."
argument-hint: "[plan | apply] [spec-glob] [--section <name>] [--truth spec|code] [--sink workflow|backlog|report] [--yes] — default 'plan' (read-only drift report)"
---

# Spec ⇄ code reconciler

Treat the **spec as desired state** and the **code as actual state**, then run the
terraform loop over them:

- **`plan`** (default) — compute the **drift** between spec and code, in both
  directions, and write a report. **Read-only** — it changes neither the spec nor
  the code (the same posture as `/rig-review find`).
- **`apply`** — reconcile the actionable drift. rig-sync's `apply` is **not
  "write code"** — code generated from a spec is non-deterministic and must be
  reviewed. It routes the drift to a **pluggable sink** (below), each of which
  keeps the review/gate; the only things `apply` writes itself are spec-side
  artifacts (the projection, doc drift), which are safe.

Unlike `/rig-plan` — greenfield, spec → *initial* backlog with nothing to diff
against — rig-sync is **continuous**: it diffs the spec against the code you
already have and proposes only what reconciles the difference.

## Reconciliation sinks

Where `apply` sends the drift is a choice about **lifespan × audience**, not a
fixed pipeline. A ticket does two jobs — *dispatch* work to a worker, and
*govern/record* it for humans. For AI work the dispatch half is overhead (the
worker is autonomous), so tickets are not the default.

- **`workflow`** (default) — generate a **Smithers workflow** from the drift and
  run it ephemerally: it does the reconciliation now, with its own approval gate,
  durability, retries, and a live run record — governance without a permanent
  ticket. Best for the continuous case, where board churn would be noise.
- **`backlog`** — create **one milestone** ("reconcile `<spec>` → drift vN") and
  hand the drift to `/rig-plan`, so units land as tickets grouped under that
  milestone (not loose issues). Best when the drift needs human prioritization,
  scheduling, or cross-team visibility over time.
- **`report`** — write the drift + proposed units to files only; a human decides.

The **drift report is written regardless of sink** — it is the durable record of
intent that lets ephemeral execution be resumed or explained later.

## Configuration

Reads `.rig/config.json` (defaults in parentheses):

- `sync.specGlob` — the desired-state source: one file or a glob of spec/catalog
  docs (default: first of `SPEC.md`, `specs/prd.md`, `docs/prd.md`).
- `sync.projection` — optional path to a **generated, machine-readable
  projection** of the spec (e.g. `.rig/spec.lock.json` or `spec/`). The diffable
  middle layer — the analogue of a terraform state file. When set, rig-sync
  regenerates it from the spec and diffs *it* against code; unset, the agent
  reasons prose-spec vs code directly (coarser).
- `sync.extractor` — a **project-supplied adapter** that enumerates the actual
  surface of the code as structured JSON (see *The extractor adapter*).
  Resolver: `.rig/rig-sync-extractor` if executable, else the value of this key,
  else none. With no extractor, actual-state discovery is best-effort agent
  reasoning over `sourceScope` — **say so** in the report.
- `sync.preserve` — globs of hand-maintained files/regions inside the projection
  that are **never regenerated** — preserved verbatim; rig-sync only cross-checks
  them and flags contradictions.
- `sync.truth` — default direction of truth when spec and code disagree:
  `spec` (spec wins → code drift becomes work) · `code` (code wins → spec drift
  becomes a doc update) · `ask` (default — report both, human decides).
- `sync.apply.sink` — default reconciliation sink: `workflow` (default) ·
  `backlog` · `report`. `--sink` overrides per run.
- `sync.driftReport` — where the report is written (default `.rig/DRIFT.md`).
- Reused: `sourceScope` (areas the extractor/agent scans), `agents.architect`
  (extraction + drift reasoning), `vcs.baseRef` (projection baseline for
  re-runs), and — for the `backlog` sink only — `tracker.*` + `tracker.board`.

`apply` delegates: the `backlog` sink to `/rig-plan` (which fans out to
`/rig-epic` / `/rig-sprint` / `/rig-issue`); the `workflow` sink to Smithers. It
never invokes `/rig-task` to write code itself.

## The extractor adapter

Drift only generalizes if rig-sync doesn't hardcode what "a surface" is. The
project owns that, exactly like the `rig-tracker` adapter owns "a board." The
extractor is any executable that prints JSON to stdout:

```json
{
  "surface": [
    { "kind": "topic", "id": "orders.filled", "role": "producer",
      "owner": "services/matching", "ref": "services/matching/publish.ts:42" }
  ],
  "invariants": [
    { "assert": "every topic has exactly one producer" }
  ]
}
```

Each element is keyed by `(kind, id)`. rig-sync diffs the code's `surface`
against the spec's expected surface (from the projection) on that key, staying
domain-agnostic: `kind` can be `topic`, `rpc`, `endpoint`, `table`, `flag`,
`cli-command` — whatever the extractor emits. `invariants` are project-declared
assertions rig-sync checks against the merged set.

## Arguments

`$ARGUMENTS` begins with an optional verb, then args:

- **`plan [spec-glob]`** (default) — drift report only.
- **`apply [spec-glob]`** — reconcile after approval.
- `[spec-glob]` — override `sync.specGlob`.
- `--section <name>` — restrict to one spec section/milestone (match a heading).
- `--truth spec|code` — override `sync.truth`.
- `--sink workflow|backlog|report` — override `sync.apply.sink`.
- `--yes` — skip the `apply` approval gate. Default is to STOP for review.

## Procedure

1. **Resolve** config, the spec source(s), and the extractor. If no spec is
   found, ask. Read the whole spec (or just the `--section`).

2. **Build the desired-state projection — fresh context, `agents.architect`.**
   When `sync.projection` is set, extract the spec's expected surface into the
   projection format. **Do not invent**: record ambiguity as anomalies and
   spec-internal contradictions in the report, never as invented surface.
   **Preserve `sync.preserve` regions verbatim.** No projection configured → skip
   and carry the spec forward as prose.

3. **Extract the actual state.** Run the extractor over `sourceScope`; capture
   its `surface` + `invariants`. No extractor → `agents.architect` enumerates the
   surface heuristically from `sourceScope`, marked **best-effort** in the report.

4. **Diff desired vs actual — both directions.** Classify every element:
   - **missing** — in the spec, absent from the code → reconcilable *work*.
   - **undocumented** — in the code, absent from the spec → a *spec* update, or
     out-of-scope code to flag.
   - **diverged** — present on both sides but attributes disagree → a decision,
     resolved by `truth`.
   Then check the extractor's `invariants` against the merged set; a violation is
   a finding in its own right.

5. **Report — then STOP** (where `plan` ends). Write `sync.driftReport` and print
   a summary: counts per class, invariant violations, and which side `truth`
   favors for each diverged item. This is the terraform *plan*.

6. **Apply — on approval only, and never by editing product code.** Split the
   drift: **missing** + spec-winning **diverged** are *work*; **undocumented** +
   code-winning **diverged** are *spec/doc* fixes. Then, by sink:
   - **`workflow`** → synthesize a scoped drift-spec and generate a **Smithers
     workflow** that reconciles it — one lane per unit, each built through
     `/rig-task` *inside the workflow* so the RED→GREEN→review gates still hold,
     with a workflow-level approval before anything merges. Ephemeral: no
     tickets. (Smithers unavailable → fall back to `backlog`, and say so.)
   - **`backlog`** → create one milestone `reconcile <spec> → drift vN` and hand
     the drift-spec to `/rig-plan`; the units land as tickets under that
     milestone on the board.
   - **`report`** → write the drift-spec + proposed units to `.rig/plan.md`.
   For the *spec/doc* side (any sink): write the projection + a **proposed**
   catalog/doc change (docs are safe) and flag it for human confirmation — never
   silently rewrite the human spec.
   **Refresh + gate.** Regenerate the projection (preserving `sync.preserve`).
   For every unit whose contract drifted, reset its board/run gate no higher than
   a *contract-re-verify* state so a stale acknowledgment can't ride along.

7. **Report + hand off.** Print what was produced — the workflow run (or the
   milestone + ticket IDs + board link, or the plan file), plus which spec-side
   files changed — and the next step. rig-sync's job ends at **reconciliation in
   motion + an updated projection**, not at modified product code.

## Notes

- **Plan/apply, not auto-code.** `plan` is a read-only drift report; `apply`
  routes drift to a sink that keeps a gate — never keystrokes into your source.
  That boundary is what makes the gate meaningful, same as `/rig-plan` never
  starting work and `/rig-review find` never editing.
- **Tickets aren't the default.** For AI work the dispatch half of a ticket is
  overhead. The ephemeral `workflow` sink gives governance (approval + live run +
  history) without permanent board churn; reach for `backlog` only when the drift
  needs human scheduling or lasting cross-team visibility.
- **The record survives the run.** The drift report is written for every sink, so
  ephemeral execution is still resumable and explainable after the fact.
- **Direction of truth is a human call.** rig-sync reports both directions and
  defaults to `ask`; it auto-picks only under `sync.truth` / `--truth`.
- **The adapter is the seam.** Without `sync.extractor` this degrades to
  best-effort agent reasoning — fine for a read, not authoritative. A crisp
  extractor (a pub/sub registry, an OpenAPI surface, a schema catalog) makes
  drift precise and portable.
- **Re-runnable / idempotent.** Match drift to existing work by surface
  `(kind, id)` so a re-run proposes only *new* drift and won't duplicate a
  workflow lane or a ticket already in flight.
- **Degrades.** No projection → prose vs code. No extractor → heuristic surface.
  No Smithers → `workflow` falls back to `backlog`. `tracker: none` → `backlog`
  falls back to `report`. Useful at every rung.
