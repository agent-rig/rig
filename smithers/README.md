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
| `workflows/rig-epic.tsx` | Integration-branch epic: preflight → plan → front-loaded Arch/QA spec → **spec gate** → per-child `rig-task` fan-out (Subflow) → combined-diff review → finish (squash PR). |
| `workflows/rig-task.tsx` | One unit of work: preflight → setup → spec review → RED → GREEN loop → refactor → review-find/fix loop → PR → review-bot. |
| `ui/rig-epic.tsx`, `ui/rig-task.tsx` | The `<UI entry>` dashboards (`smithers ui <runId>`). |
| `agents.example.ts` | **Reference only** — a machine-generated `agents.ts`. See "Consuming project" below. |

## The advisor gate (autonomous arch gate)

Tracked by [agent-rig/rig#13](https://github.com/agent-rig/rig/issues/13).

`rig-epic` takes an `advisor` input flag. By default the front-loaded spec gate
(`spec-direction`) is a `<HumanTask>` — a human reads the Architect + QA specs,
types free-form direction, and sets `proceed`. With **`advisor: true`** that same
node renders as a Fable (`providers.claude`) `<Task>` instead: it reads the specs,
then either

- `proceed: true` → synthesizes the per-child `direction` and fans out unattended, or
- `proceed: false` → the epic **halts with a blocked report** (no human waits).

Same node id + `{ proceed, direction }` schema as the human gate, so everything
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
