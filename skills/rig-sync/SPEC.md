# SPEC — rig-sync (spec ⇄ code reconciliation)

## Goal

`rig-sync` keeps a repo in sync with its spec — the **terraform loop for code**.
Treat the spec as **desired state** and the code as **actual state**; compute the
**drift** between them (`plan`) and **reconcile** it (`apply`).

The reconciliation *executes on a durable, engine-agnostic substrate* (Smithers)
so that:

- a **large reconciliation can run for hours or days**, survive a crash, and
  **resume** from the last completed step;
- it is **multi-modal** — worker seats can be any agent engine (claude, codex,
  kimi, …), chosen by the *target project's* config, never hardcoded by rig.

rig-sync produces the workflow **cheaply** (a parameterized workflow, drift as
input — authored directly, *not* via an interactive workflow-authoring assistant)
and hands it to the durable engine to run.

## Non-goals

- **Never edits product code directly.** Every code change flows through a gated
  build loop (RED → GREEN → review), same as `rig-task`.
- **No per-run workflow *authoring*.** The reconcile workflow is authored **once**
  and parameterized by the drift. rig-sync must not invoke a 40-minute
  `make-workflow`-style authoring pipeline on every `apply`.
- **No engine/runtime lock-in.** rig-sync itself picks no model; the durable
  engine + the project's agent config decide.

## Model

`plan` (read-only) → `apply` (reconcile via a **pluggable sink**). Direction of
truth is a human call (`sync.truth`: `spec` | `code` | `ask`, default `ask`).

## Milestones

### Milestone 0 — `plan`: read-only drift  *(foundation — start here)*

Small, pure, unit-testable. No execution, no writes to product code.

- **T1 · Config.** Add a `sync` block to `rig.schema.json` + `rig.config.example.json`:
  `specGlob`, `projection?`, `extractor`, `preserve[]`, `truth`, `apply.sink`,
  `driftReport`. Schema-validated; `rig-doctor` recognizes it.
- **T2 · Extractor adapter.** A project-supplied executable that enumerates the
  code's actual surface as JSON `{ surface:[{kind,id,role,owner,ref}], invariants:[{assert}] }`.
  Resolver: `.rig/rig-sync-extractor` if executable, else `sync.extractor`, else
  best-effort agent scan. Ship the contract doc + a reference extractor + tests.
  (Same adapter pattern as `rig-tracker`.)
- **T3 · Drift engine.** Diff desired surface (from spec/projection) vs actual
  (extractor), keyed by `(kind,id)` → classify **missing / undocumented /
  diverged**; check declared `invariants`. Pure function, unit-tested both ways.
- **T4 · Drift report.** Write `sync.driftReport` (`.rig/DRIFT.md`, terraform-plan
  style: counts per class, invariant violations, truth verdict per diverged item)
  + a printed summary.
- **T5 · `plan` verb.** Wire the SKILL: resolve config/spec/extractor → build
  desired → run extractor → diff → report → **STOP** (read-only, like
  `rig-review find`).

### Milestone 1 — `apply`: `report` + `backlog` sinks

Reconciliation that reuses existing rig machinery; no new runtime.

- **T6 · Drift → drift-spec.** Split drift into *work* (missing + spec-winning
  diverged) and *doc* (undocumented + code-winning diverged); synthesize a scoped
  reconciling spec.
- **T7 · `report` sink.** Write the drift-spec + proposed units to `.rig/plan.md`.
  The always-available rung.
- **T8 · `backlog` sink.** Create **one milestone** (`reconcile <spec> → drift vN`)
  and hand the drift-spec to `/rig-plan` so units land as grouped tickets on the
  board. For drift that needs human scheduling / cross-team visibility.

### Milestone 2 — `apply`: `workflow` sink (durable, multi-modal)  *(epic)*

The durable execution path — the reason we use Smithers. One **parameterized**
reconcile workflow, drift as input; `apply --sink workflow` runs it.

- **T9 · `smithers/workflows/rig-sync.tsx`.** A parameterized reconcile workflow
  taking a `driftReport` input. Shape (validated by the make-workflow spike):
  `verify-drift` (re-run extractor; self-healed units short-circuit) → **test-runner
  scaffold** (bootstrap a runner if the repo has none, pre-fork on trunk) →
  per-unit `<Worktree>` + `<ReviewLoop>` lanes (RED→GREEN for code units, review-only
  for doc units; escalate on max iterations) → **plan gate** + **merge gate**
  (`<Approval>`, subset approval) → `<MergeQueue>` (rebase → merge → test, with a
  merge-fix loop) → **final-verify** (re-run extractor vs spec ⇒ **zero residual
  drift**) → report. Must render under `smithers graph`.
- **T10 · `workflow` sink wiring.** `apply --sink workflow` composes drift → input
  and runs it (`smithers up`), reports the run id + how to monitor, and degrades
  to `backlog` when Smithers is absent (say so).
- **T11 · Engine-agnostic docs.** Document that worker model tiering comes from the
  *target project's* Smithers `agents.ts` / accounts — rig picks nothing.

### Milestone 3 — projection layer  *(optional)*

- **T12 · Machine projection.** Generate a diffable `sync.projection` (the
  terraform state-file analogue) from the spec, diff *it* vs code, and preserve
  `sync.preserve` regions verbatim.

## Success criteria

1. `rig-sync plan` on a drifted repo produces an accurate **bidirectional**
   `DRIFT.md` (missing / undocumented / diverged + invariant checks).
2. `rig-sync apply --sink report` writes a correct reconciling drift-spec; touches
   no product code.
3. `rig-sync apply --sink workflow` runs the **durable** reconcile workflow with
   the drift as input and (given a model account) reconciles to **zero residual
   drift**, **resumable across a crash**.
4. No product code is ever edited outside the gated build loops.
5. rig-sync runs the same regardless of agent engine — **multi-modal, no lock-in**.

> Reference sandbox: `demos/notes-api` (spec + drifted code + a working extractor).
> `make-workflow` was a spike to discover the workflow *shape*; the shipped sink
> **runs** the parameterized workflow, it does not author one per run.
