# notes-api — a rig-sync sandbox

A tiny Notes HTTP API whose code has **drifted from its spec on purpose**. Use it
to try [`rig-sync`](../../skills/rig-sync/SKILL.md): treat `SPEC.md` as desired
state, `src/` as actual state, and reconcile.

```
notes-api/
├── SPEC.md                    desired state — the API surface + invariants
├── src/app.js                 actual state — Express routes (with planted drift)
├── .rig/
│   ├── config.json            sync config (tracker: none, apply sink: report)
│   └── rig-sync-extractor     the extractor adapter (enumerates code routes → JSON)
└── .claude/                   rig-sync skill + rig-architect agent, copied in so it runs here
```

## Try it

From this directory, in Claude Code:

```
/rig-sync plan
```

**Read-only.** It builds the desired surface from `SPEC.md`, runs the extractor
to get the actual surface from `src/`, diffs them, and writes `.rig/DRIFT.md`.

### What `plan` should find

Three drifts (plus both invariants violated):

| Class | Element | Why |
|-------|---------|-----|
| **missing** | `DELETE /notes/{id}` | in the spec, no handler in `src/` → work to do |
| **diverged** | `PUT /notes/{id}` ⇄ `PATCH /notes/{id}` | spec wants a full replace (`PUT`); code implements `PATCH` on the same resource |
| **undocumented** | `GET /health` | code serves it, spec never mentions it → spec update or out-of-scope |

Because `sync.truth` is `ask`, `plan` reports both directions and doesn't pick a
winner for the divergence — that's your call.

### Then reconcile

```
/rig-sync apply --sink report
```

With `tracker: none` and the `report` sink, `apply` won't touch `src/` — it
writes the proposed reconciliation backlog to `.rig/plan.md` (e.g. *add
`DELETE /notes/{id}`*, *decide `PUT` vs `PATCH`*, *spec `GET /health` or remove
it*). Switch `sync.apply.sink` to `backlog` (with a tracker) or `workflow` (with
Smithers) to route the same drift to a milestone or an ephemeral workflow.

## Peek under the hood

The extractor is the only demo-specific piece — run it directly to see the
actual-state JSON rig-sync consumes:

```
.rig/rig-sync-extractor
```

To change the drift, edit `src/app.js` (add the `DELETE` handler, rename `PATCH`
to `PUT`, remove `/health`) and re-run `/rig-sync plan` — it should come back
clean.
