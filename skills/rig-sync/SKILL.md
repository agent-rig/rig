---
name: rig-sync
description: "Keep a repo in sync with its spec — the terraform loop for code. Treats the spec as desired state and the code as actual state, computes the drift between them (both directions), and reconciles it. `plan` (default): read-only drift report — what the spec demands that the code lacks, and what the code has that the spec doesn't. `apply`: reconcile the actionable drift through a pluggable sink — a durable Smithers workflow (default), a tracked milestone of tickets, or report-only — and it never edits product code directly. Triggers on: 'rig-sync', 'sync the repo to the spec', 'spec sync', 'spec drift', 'drift between spec and code', 'reconcile spec and code', 'is the code still in sync with the spec', 'what changed vs the spec', 'terraform for code', 'plan the spec drift'."
argument-hint: "[plan | apply] [spec-glob] [--section <name>] [--truth spec|code] [--sink workflow|backlog|report] [--yes] — default 'plan' (read-only drift report)"
---

# Spec ⇄ code reconciler

Treat the **spec as desired state** and the **code as actual state**, then run the
terraform loop over them:

- **`plan`** (default) — compute the **drift** between spec and code, in both
  directions, and write a report. **Read-only** (same posture as `/rig-review find`).
- **`apply`** — reconcile the actionable drift. rig-sync's `apply` is **not
  "write code"** — it routes the drift to a **pluggable sink**, each of which keeps
  a gate. The only things `apply` writes itself are spec-side artifacts.

The deterministic diff lives in `scripts/rig-sync.ts`; this skill orchestrates it.
Full reference: [`docs/rig-sync.md`](../../docs/rig-sync.md).

## Configuration

Reads the `sync` block of `.rig/config.json` (defaults in parentheses):

- `sync.specGlob` (`SPEC.md`) — the desired-state source.
- `sync.projection` — optional machine-readable projection of the spec (the
  diffable middle layer); unset ⇒ derive the desired surface from the prose spec.
- `sync.extractor` — the code's actual-surface adapter. **Resolver:**
  `.rig/rig-sync-extractor` if executable, else this value, else a best-effort
  agent scan of `sourceScope` (**say so** in the report).
- `sync.preserve[]` — projection regions never regenerated (preserved verbatim).
- `sync.truth` (`ask`) — direction of truth on a divergence: `spec` | `code` | `ask`.
- `sync.apply.sink` (`workflow`) — `workflow` | `backlog` | `report`. `--sink` overrides.
- `sync.driftReport` (`.rig/DRIFT.md`) — where the report is written.
- Reused: `sourceScope`, `agents.architect`, `vcs.baseRef`, and — for the
  `backlog` sink — `tracker.*` + `tracker.board`.

## The extractor adapter

The project owns "what a surface is" (the `rig-tracker` pattern). The extractor
prints JSON `{ surface:[{kind,id,role?,owner?,ref?,attrs?}], invariants:[{assert}] }`;
`(kind,id)` is the unique identity, `role`/`attrs` are the *directionally*
compared fields, `owner`/`ref` are location metadata. Validate one with
`bun scripts/rig-sync.ts validate-extractor <file>`. Contract + a reference
extractor: [`docs/rig-sync.md`](../../docs/rig-sync.md).

## Verbs & arguments

`$ARGUMENTS` begins with an optional verb, then args:

- **`plan [spec-glob]`** (default) — drift report only.
- **`apply [spec-glob]`** — reconcile after approval.
- `--section <name>` — restrict to one spec section/milestone.
- `--truth spec|code` · `--sink workflow|backlog|report` · `--yes` (skip the
  `apply` approval).

## Procedure

### `plan` — the read-only gate

1. **Resolve** config, the spec source, and the extractor (resolver above). Read
   the spec (or just `--section`).
2. **Desired surface — fresh context, `agents.architect`.** Extract the spec's
   expected surface into the adapter shape (`[{kind,id,role?,attrs?}]`). If
   `sync.projection` is set, regenerate it and use it; **do not invent** — record
   ambiguity, preserve `sync.preserve` regions. Write it to a temp file.
3. **Actual surface.** Run the resolved extractor over `sourceScope`; capture its
   stdout. Validate it: `bun scripts/rig-sync.ts validate-extractor <actual>` —
   stop and report if it's malformed. (No extractor ⇒ have `agents.architect`
   enumerate the surface, mark **best-effort**.)
4. **Diff + report — deterministic.**
   ```bash
   bun <RIG_DIR>/scripts/rig-sync.ts report \
     --desired <desired.json> --actual <actual.json> \
     --out {sync.driftReport} --truth {sync.truth} --project {project.name} --spec {sync.specGlob}
   ```
   (`<RIG_DIR>` = `.rig/rig` if vendored, else the kit checkout. Use `diff` for
   raw JSON.) This classifies **missing / undocumented / diverged / aligned** and
   checks carried invariants.
5. **Report — then STOP.** Print the summary (counts, invariant list, per-diverged
   truth verdict) and the `DRIFT.md` path. `plan` changes nothing else.

### `apply` — reconcile through a sink

On approval only, and **never by editing product code**. Split the drift:
**missing** + spec-winning **diverged** are *work*; **undocumented** + code-winning
**diverged** are *spec/doc* fixes. Then, by `sync.apply.sink`:

- **`workflow`** (default) — run the **durable, parameterized reconcile workflow**
  on Smithers with the drift as **input**: `smithers up <RIG_DIR>/smithers/workflows/rig-sync.tsx
  --input <drift.json>`. It is authored **once** and parameterized per run — do
  **not** generate a new workflow per drift, and do **not** use `smithers
  make-workflow` (that is an authoring assistant, not a runtime step). It survives
  crashes and resumes over days. Its two seats (coder, reviewer) **default to your
  Claude account** (`ClaudeCodeAgent`), so it runs with no `.smithers/agents.ts`
  to configure; swap them for your own `agents.ts` pools to go multi-modal. Report
  the run id + how to monitor. If Smithers is absent, fall back to `backlog`.
- **`backlog`** — create one milestone (`reconcile <spec> → drift vN`) and hand the
  drift-spec to `/rig-plan`; units land as tickets on the board.
- **`report`** — write the drift-spec + proposed units to `.rig/plan.md`.

For the *spec/doc* side (any sink): write the projection + a **proposed** doc
change and flag it — never silently rewrite the human spec. Then **refresh** the
projection (preserving `sync.preserve`).

## Notes

- **Plan/apply, not auto-code.** `plan` reports; `apply` routes drift to a gated
  sink. That boundary is the whole point — same as `/rig-plan` never starting work.
- **One workflow, run many.** The reconcile workflow is a durable artifact
  (`smithers/workflows/rig-sync.tsx`) parameterized by drift, not regenerated per
  run. Authoring it is a one-time cost; running it is cheap and resumable.
- **Runs out of the box, still multi-modal.** The workflow's seats default to
  Claude (`ClaudeCodeAgent`) so it just runs; execution is Smithers, so swapping
  the seats for your `agents.ts` pools gives you any engine. The `report`/`backlog`
  sinks need no runtime at all.
- **Direction of truth is a human call** — `sync.truth` / `--truth`; default `ask`.
- **The adapter is the seam.** Without an extractor, coverage is best-effort agent
  reasoning — fine for a read, not authoritative.
- **Degrades.** No projection → prose vs code. No extractor → heuristic surface.
  No Smithers → `workflow` falls back to `backlog`. `tracker: none` → `backlog`
  falls back to `report`.
