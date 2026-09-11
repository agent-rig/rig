# Run state (`rig-state`)

A rig skill is a long procedure. `/rig-task` spans seven steps and four
delegated agents; `/rig-epic run` loops that over every child. The host agent's
only memory of what happened between those steps is its transcript. When that
transcript compacts mid-run, three things go with it: the acceptance criteria,
which test went red and why, and which review findings are already fixed. The
agent then re-derives them from `git` and `gh`, or guesses.

`rig-state` replaces that memory with one small structured document per run,
kept on disk and validated outside the model:

```
.rig/state/<run-id>.json     the current state — what the next step reads
.rig/state/<run-id>.jsonl    an append-only journal of accepted patches
```

The state is the working memory. The journal is the audit trail, there so a
human can debug a failed run. **Never feed the journal to a model.** That
reintroduces the history the state replaces.

Both are throwaway coordination state, rebuildable from the tracker and the
repo, and **gitignored — never committed**. `/rig-doctor` checks that.

## The contract

Each step of a skill does three things, in this order:

1. Read the state (`rig-state show <run-id>`) instead of scrolling back.
2. Do the step's work.
3. Persist what a *later* step needs, as a patch — not a summary of what
   happened.

That third rule is the one that matters. Record facts and decisions the next
step reads: the branch name, the failing assertion, the reason you rejected an
approach. Don't record narration. If a later step never reads it, it doesn't go
in the state.

## Commands

`<SCRIPTS>` resolves from the repo root: `.claude/scripts/` first, then
`.rig/scripts/`, first hit wins — the same rule `/rig-worktree` uses. Run these
with `bun` (or your TypeScript runner).

| Command | Does |
|---|---|
| `rig-state.ts init <skill> <run-id> [--json '{…}']` | Start a run at the skill's first phase. Fails if the run exists. |
| `rig-state.ts patch <run-id> --json '{…}' [--step <label>]` | Merge a patch, validate the result, journal it. `--json -` reads stdin. |
| `rig-state.ts show <run-id>` | Render the compact block you paste into a subagent prompt. |
| `rig-state.ts get <run-id> [--field <dotted.path>]` | Raw JSON, or one field. |
| `rig-state.ts list [--skill <name>]` | Active runs: id, skill, phase, updated, next action. |
| `rig-state.ts journal <run-id>` | The accepted patches, for a human debugging a run. |
| `rig-state.ts rm <run-id>` | Delete the run's state and journal. |

Exit codes: `0` accepted, `1` rejected, `2` usage error or missing run.

## Patch semantics

Patches merge; they don't replace. So a step sends only what changed, and never
has to reproduce the whole document:

- Nested objects deep-merge. `{"tests":{"status":"green"}}` keeps
  `tests.command`.
- `null` deletes a key. `{"blockers":null}` clears the blockers.
- Arrays replace wholesale. Treating an array as one atomic value keeps the
  merge unambiguous: to add a finding, send the new list.
- `runId`, `skill`, and `createdAt` are set at `init` and never patched.

## Validation happens outside the model

A rejected patch leaves the state exactly as it was. It prints the reason on
stderr and the unchanged state on stdout, so the fix-and-retry loop needs no
extra read. A patch is rejected when it carries:

- **An unknown key**, at the top level or nested. The rejection lists the keys
  the schema knows. This is what stops the state from drifting into a memory
  blob.
- **A wrong type**, or a value outside a field's enum.
- **An undeclared phase** for that skill.
- **An oversized value.** A string caps at 500 characters, an array at 50
  items, and the whole document at 8 KB. Hitting a cap means summarize, not
  raise the cap — the budget is what keeps the state a state.
- **A guard violation** — a combination that can't be true (below).
- **A move off a terminal phase** (`done`, `abandoned`) without `--force`. A
  finished run doesn't quietly restart.

## Phases and guards, per skill

Guards encode the gates the skill already describes in prose. A state that
claims to have passed a gate has to satisfy it.

**`rig-task`** — `spec → spec-review → red → green → refactor → self-review →
pr-open → review-loop → done` (plus `abandoned`).

- `pr-open` and beyond require `tests.status: green`. Step 4 has to be GREEN
  before a push.
- `pr-open` and beyond require `review.p0: 0` and `review.p1: 0`. Step 4.5 is a
  gate, not a suggestion.
- `done` requires a `pr.number`.

**`rig-epic`** — `plan → start → run → review → finish → done`.

- `finish` requires every child at `merged`.
- `review` requires at least one merged child.
- A child at `merged` has to record its `branch`.

**`rig-review`** — `find → fix → done`.

- Outcome `clean` requires no finding still `open`.
- `round` must not exceed `maxRounds`; past that, a human takes it.

## Run IDs

Use the unit's identity, lowercased: the ticket (`abc-18`), the integration
branch for an epic (`abc-42-agent-as-definition`), or `pr-<number>` for a review
loop. A run id has to match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}` — it becomes a
filename.

Reuse the id across a `start`/`finish` split. That reuse is the point: `finish`
resolves the same run and reads what `start` recorded instead of reconstructing
it.

## What this does not do

- **It doesn't shorten the host agent's context.** rig ships markdown
  procedures; Claude Code and pi own their own loops and still send their
  transcripts. What the state changes is the *cost of losing* that transcript.
- **It can't recover a fact nobody recorded.** If a step needs an observation
  no patch persisted, the state won't have it. Re-derive it from the repo or the
  tracker; the journal is how a human diagnoses the omission afterward.
- **It isn't the source of truth for work that lives elsewhere.** The tracker
  owns ticket status; git owns the branches; the PR owns the review. The state
  records rig's position in the procedure, and caches only what re-fetching
  would cost a step.
