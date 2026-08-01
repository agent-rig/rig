# rig-sync — spec ⇄ code reconciliation

`rig-sync` keeps a repo in sync with its spec — the **terraform loop for code**.
The spec is **desired state**, the code is **actual state**; `plan` computes the
**drift** and `apply` reconciles it. `plan` is read-only; `apply` never edits
product code directly (it routes drift to a gated sink).

## The pieces

| Piece | What it is |
|---|---|
| **desired surface** | what the spec requires, as structured elements. Produced from the spec by an agent (or a generated `sync.projection`). |
| **actual surface** | what the code actually exposes. Produced by the project's **extractor adapter**. |
| **drift engine** | `scripts/rig-sync.ts` — the deterministic diff of desired vs actual. |
| **sinks** | how `apply` reconciles: a durable Smithers workflow, a tracker backlog, or a report. |

## The extractor adapter

Drift only generalises if rig-sync doesn't hardcode what "a surface" is. The
**project owns that**, exactly like the `rig-tracker` adapter owns "a board." The
extractor is any executable that prints this JSON to stdout:

```json
{
  "surface": [
    { "kind": "endpoint", "id": "GET /notes/{id}", "role": "route",
      "owner": "src", "ref": "src/app.js:28" }
  ],
  "invariants": [
    { "assert": "every endpoint in SPEC.md has a handler in src/" }
  ]
}
```

- **`kind` + `id`** are the identity; `(kind,id)` must be **unique**. `kind` is
  whatever the project models — `endpoint`, `topic`, `rpc`, `table`, `flag`,
  `cli-command`, …
- **`role`** and **`attrs`** (an optional object) are the *comparable* fields:
  when the same `(kind,id)` exists on both sides but the spec declares a `role`
  or `attrs` the code doesn't match, that's a **divergence**. The comparison is
  **directional** — the spec is a partial contract, so extra detail the code
  carries (extra `attrs`, `role`, `owner`, `ref`) is *never* a divergence.
- **`owner`** / **`ref`** are location metadata (for the report); never compared.
- **`invariants`** are project-declared assertions carried through to the
  reconcile step (the drift engine reports them; it does not evaluate free text).

**Resolver** (highest first): `.rig/rig-sync-extractor` if executable → the
`sync.extractor` config value → a best-effort agent scan of `sourceScope` (marked
*best-effort* in the report).

**Validate** an extractor before wiring it in:

```
bun scripts/rig-sync.ts validate-extractor .rig/actual.json   # or pipe on stdin
```

A working reference extractor (HTTP routes, ~40 lines of Python, grep-based)
lives at [`demos/notes-api/.rig/rig-sync-extractor`](../demos/notes-api/.rig/rig-sync-extractor).

## The drift engine

`scripts/rig-sync.ts` (Bun) diffs two surface docs and classifies every element:

- **missing** — in the spec, absent from the code → *work*.
- **undocumented** — in the code, absent from the spec → *spec/doc* (or out of scope).
- **diverged** — present both sides, a spec-declared field differs → *decision* (resolved by `sync.truth`).
- **aligned** — present both sides, code satisfies the spec.

```
bun scripts/rig-sync.ts diff   --desired desired.json --actual actual.json
bun scripts/rig-sync.ts report --desired desired.json --actual actual.json --out .rig/DRIFT.md --truth ask
```

## Sinks (`apply`)

Chosen by `sync.apply.sink`:

- **`workflow`** (default) — run the **durable Smithers reconcile workflow** with
  the drift as input. It survives crashes and resumes over days. rig-sync ships
  the workflow (authored once, parameterized by drift); it does **not** author a
  new workflow per run.
  - **Agents: runs on your Claude account out of the box.** The workflow's two
    seats (coder, reviewer) default to `ClaudeCodeAgent` — so it runs immediately
    with no `.smithers/agents.ts` to configure, and never inherits `smithers
    init`'s Codex/Fable-first pools. **Still multi-modal:** to run any engine
    Smithers supports, swap those seats for your own `agents.ts` pools (one edit
    in `smithers/workflows/rig-sync.tsx`). rig defaults to the provider you're
    already using; it doesn't force one.
- **`backlog`** — one milestone + tickets via `/rig-plan` (board-native).
- **`report`** — write the drift-spec to a file only.

## Configuration

See the `sync` block in [`rig.schema.json`](../rig.schema.json) /
[`rig.config.example.json`](../rig.config.example.json): `specGlob`, `projection?`,
`extractor`, `preserve[]`, `truth`, `driftReport`, `apply.sink`.
