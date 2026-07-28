# The tracker/board adapter (`rig-tracker`)

rig's tracker surface has two kinds of need:

- **identity** — "my epic label is `epic`", "my Project is #7". Declarative; lives in `.rig/config.json`.
- **policy** — "what counts as *dispatchable*?", "how does a card move?". Open-ended and per-project; would be a treadmill as config schema.

So policy lives in **code, behind one small contract** — the `rig-tracker` adapter. It's the *one sanctioned fork point* in rig; everything else stays config-over-forking.

## Contract

```
rig-tracker <verb> [flags]
```

JSON to **stdout**, human logs to **stderr**, exit code = success/failure — so an LLM skill and a smithers/TS workflow consume the same output.

| Verb | Does | Emits |
|---|---|---|
| `select [--status <name>] [--label <name>]… [--dispatchable] [--limit N]` | Query issues. `--status` filters by the Project **board column** (ProjectV2); `--label` by issue label; `--dispatchable` = the default policy *status == `board.statusOptions.todo` AND label ∈ `shapeLabels`*. | `[{id,number,title,url,status,labels,blockedBy}]` |
| `next` | `select --dispatchable --limit 1` — the next unit an autonomous loop should pick up. | same as `select` |
| `link-pr <issue#> <pr#>` | Ensure the PR links/closes the issue (default: a `<closingKeyword> #N` line in the PR body → GitHub links it and moves the board on merge). | `{linked,issue,pr,already}` |
| `set-status <issue#> <status-name>` | Move the issue's board item to a column (ProjectV2 `item-edit`; option IDs resolved at runtime). | `{moved,issue,status}` |
| `add-to-project <issue#>` | Add the issue to the configured Project board. | `{added,issue}` |

## Resolver — how callers invoke it

Prefer the project's override, else rig's shipped default:

```sh
TRACKER="$( [ -x .rig/rig-tracker ] && echo .rig/rig-tracker \
            || echo "$RIG_DIR/scripts/rig-tracker.sh" )"
"$TRACKER" select --status Todo --dispatchable        # → JSON on stdout
```

- **Default:** `scripts/rig-tracker.sh` — rig-owned, refreshed on re-sync, **never edited in place** by a consumer.
- **Override:** `.rig/rig-tracker` (any executable) — project-owned, rig never touches it. This is where a bespoke dispatcher / a Linear-via-API impl / custom fields live. Implement the same verbs + JSON contract.

## Config (`.rig/config.json` → `tracker.board`) — identity only

```json
"tracker": {
  "provider": "github",
  "shapeLabels": { "epic": "epic", "sprint": "sprint" },
  "board": {
    "owner": "acme-inc",
    "projectNumber": 7,
    "statusField": "Status",
    "statusOptions": { "todo": "Todo", "inProgress": "In Progress", "inReview": "In Review", "done": "Done" },
    "closingKeyword": "Closes"
  }
}
```

Put **human names** in `statusOptions` — the adapter resolves the underlying ProjectV2 field/option node IDs at runtime, so you never hand-copy opaque IDs.

## Providers

- **`github`** — implemented by the default: Issues API (`gh issue list`) for labels/state, ProjectV2 (`gh project …`) for board columns.
- **`none`** — degrades to empty results / no-ops.
- **`linear`** — *not* in the default (the shell has no Linear CLI). A Linear project supplies its own `.rig/rig-tracker` (curl + `LINEAR_API_KEY`) or drives Linear through the agent's MCP tools. Keeps the default runtime-agnostic and `gh`-only.

## Auth for board writes

`select --status` / `set-status` / `add-to-project` need `Projects: write`, which the default `GITHUB_TOKEN` in Actions does **not** have. Use a rig GitHub App token (`scripts/mint-gh-app-token.sh`) — the same identity can post Smithers dashboard links / run status as issue/PR comments.

## Testing

`scripts/rig-tracker.test.ts` exercises the adapter against a mock `gh` (`RIG_TRACKER_GH`) — the `select`/`link-pr`/dispatch logic is gated in CI. The ProjectV2 **write** paths (`set-status`, `add-to-project`) need a live board to integration-test.
