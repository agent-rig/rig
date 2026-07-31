# rig demos

Small, self-contained sandboxes for trying a rig skill without wiring it into a
real project. Each demo ships its own `.rig/config.json` and copies in just the
skill(s) + agent(s) it needs under `.claude/`, so you can `cd` in and run.

| Demo | Skill | What it shows |
|------|-------|---------------|
| [`notes-api`](./notes-api) | `rig-sync` | Spec ⇄ code drift on a tiny HTTP API — `plan` finds it, `apply` (report sink) proposes the fix. |

These are illustrative, not production scaffolding. In a real repo you'd install
rig with `rig-onboard` instead of copying skills in by hand.
