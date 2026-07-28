# Smithers workflow layer (WIP integration)

Durable [Smithers](https://smithers.sh) workflow equivalents of the rig skills.
This is rig's **second execution surface**: the `skills/**` prose is what an
interactive agent *follows*; these `.tsx` workflows are what an autonomous
Smithers run *executes*. The graph surface can **enforce** what prose can only
**instruct**.

> **Status: incubating.** Tracked by [agent-rig/rig#12](https://github.com/agent-rig/rig/issues/12).
> These files were seeded from a working trial; `install.sh` does **not** vendor
> them yet, and the parity contract below is not yet automated.

## Contents

| File | Role |
|---|---|
| `workflows/flows/task-flow.tsx` | **`TaskFlow`** — the one-unit graph (preflight → setup → spec review → RED → GREEN loop → refactor → review-find/fix loop → PR → review-bot) as a **composable React fragment** (no `<Workflow>`). Takes a `tables` bag + `idPrefix`, so it composes *inline* into a parent — one run, native deps, full time-travel, no childRun. Register with `taskSchemas(ns?)` / build the bag with `taskBag(...)`. |
| `workflows/flows/epic-flow.tsx` | **`EpicFlow`** — the integration-branch epic graph as a fragment: preflight → plan → front-loaded Arch/QA spec (composed `<GatherAndSynthesize>`) → **spec gate** → per-child **inline `TaskFlow`** lanes → combined-diff review → finish (squash PR). `epicSchemas(ns?)` / `epicBag(...)`. |
| `workflows/rig-task.tsx` | Thin `<Workflow>` wrapper over `TaskFlow` (the standalone `/rig-task`). |
| `workflows/rig-epic.tsx` | Thin `<Workflow>` wrapper over `EpicFlow` (the standalone `/rig-epic`). |
| `workflows/rig-crank.tsx` | **Autonomous build loop** (no skill counterpart): advisor-picks the next ready ticket from a scope, classifies epic-vs-task, composes `EpicFlow`/`TaskFlow` **inline**, verifies with an evidence-based **risk-probe gate**, lands, and loops (`continueAsNewEvery` for longevity) until the backlog is dry. |
| `workflows/rig-delegation-spike.tsx` | **Spike / evaluation** — points Smithers' off-the-shelf `DelegationChain` at one ask, to compare the delegation suite against the hand-built rig loop. Reference, not a canonical workflow. |
| `ui/rig-epic.tsx`, `ui/rig-task.tsx` | The `<UI entry>` dashboards (`smithers ui <runId>`). |
| `agents.example.ts` | **Reference only** — a machine-generated `agents.ts`. See "Consuming project" below. |

### Composable fragments (why the split)

`rig-task`/`rig-epic` used to be monolithic workflows that fanned children out
via childRun `<Subflow>`. That boundary was opaque (the monitor couldn't see into
children) and a paused child could fault the whole parent. The graph is now split
into **fragments** (`flows/*.tsx`) that a parent renders **inline**: `rig-crank`
composes `TaskFlow`/`EpicFlow`, and `EpicFlow` composes a `TaskFlow` per child —
all in **one run**, with native cross-node deps and full time-travel, no childRun.
The seams: a `tables` bag (so a fragment never assumes table *names* in the active
registry — build with `taskBag`/`epicBag`, register with `taskSchemas`/`epicSchemas`,
optionally namespaced), and an `idPrefix` (so multiple inline instances don't
collide — `deps` resolve by physical node id).

## The advisor gate (autonomous arch gate)

Tracked by [agent-rig/rig#13](https://github.com/agent-rig/rig/issues/13).

`rig-epic` takes an `advisor` input flag. By default the front-loaded spec gate
is a hand-rolled Arch/QA gather (`<Parallel>`) feeding a `<HumanTask>`
(`epic-spec-synthesize`) — a human reads the specs, types free-form direction,
and sets `proceed`. With **`advisor: true`** that whole gather-and-decide is a
composed **`<GatherAndSynthesize>`** whose synthesizer is Fable
(`providers.claude`): it reads the Architect + QA specs, then either

- `proceed: true` → synthesizes the per-child `direction` and fans out unattended, or
- `proceed: false` → the epic **halts with a blocked report** (no human waits).

Both paths share the same node ids (`epic-spec-gather-{architect,qa}`,
`epic-spec-synthesize`) + `{ proceed, direction }` schema, so everything
downstream is unchanged. This lets parallel epics run to child PRs without
parking on a human gate. The trunk merge stays human (finish stops at an open PR
unless `--merge`).

## Consuming project (what these workflows assume)

They are authored for a project that has run `smithers init` and therefore has a
`.smithers/` package (`smithers-orchestrator`, `bunfig.toml`, `preload.ts`, a
`smithers.config.ts` with `repoCommands`). Two hard dependencies:

1. **`../agents` must export `providers`** with at least the pools the ROLE maps
   reference — `claude` (Fable, used by the advisor + fallbacks), `claudeOpus`
   (architect/reviewer), `claudeSonnet` (qa/coder/coord), plus the codex pools in
   `agents.example.ts`. `agents.ts` is **machine-specific** (generated from
   `~/.smithers/accounts.json` via `smithers agents add`), so it is NOT vendored —
   regenerate it per environment. `agents.example.ts` here shows the exact pool
   names + model wiring the advisor and ROLE maps expect.
2. `rig-epic` loads `rig-task` by relative path (`RIG_TASK_REF`) and reads
   `.rig/config.json` + `.rig/epics/*.json`, i.e. it expects the rig skills
   installed alongside.

## Parity contract

rig has two surfaces that must not drift:

- **Shared artifacts** both read: `templates/REVIEWER.md`, the repo's justfile
  command names. Change once, both surfaces honor it.
- **Skill prose** (`skills/**`) — instructed, for interactive runs.
- **Workflow graph** (this dir) — enforced, for autonomous runs.

A behavior change to a skill should have a matching graph change here, and vice
versa. Where a check can be *enforced* (a real gate/command), the graph is the
source of truth; the skill prose mirrors it as guidance.

## TODO (#12)

- [ ] `install.sh`: add a `smithers` target adapter vendoring `smithers/{workflows,ui}` → `<target>/.smithers/{workflows,ui}`.
- [ ] Decide handling of `agents.ts` / `smithers.config.ts` on install (delegate to `smithers init`, or ship a template).
- [ ] Automate/verify the parity contract.
