---
name: rig-debug
description: "Systematic root-cause debugging for a failing test, production bug, flaky behavior, or unexplained error. Spawns the debugger agent through Phase 1 → 4 (root-cause → pattern analysis → hypothesis → minimal fix). Refuses to propose fixes before evidence is gathered. Triggers on: 'debug', 'why is X failing', 'root cause', 'this isn't working'."
argument-hint: "<one-line description of the bug or error message>"
allowed-tools: [Bash, Read, Grep, Glob]
---

# Debug

Drive a bug to root cause and a single minimal fix using the
four-phase methodology.

## Configuration

Reads `.rig/config.json`:

- `test.command` — how to run the test suite when collecting Phase 1
  evidence (default: `npm test`).
- `agents.debugger` — the project's name for the canonical `debugger`
  role (default: `debugger`).
- `agents.architect` — the project's name for the canonical `architect`
  role, used only when escalating (default: `architect`).

If the file is absent, use the defaults above and note you're running
unconfigured.

## The four-phase methodology

The `debugger` agent runs this loop; the skill drives it and refuses to
let it skip ahead. Each phase has a deliverable that gates the next:

- **Phase 1 — Root cause.** Gather evidence: reproduce the failure, read
  the failing code path, capture the exact error/stack/trace, `git diff`
  the suspect window. Deliverable: a stated root cause backed by
  observed evidence — not a guess.
- **Phase 2 — Pattern analysis.** Ask whether this is an instance of a
  class. Does the same bug shape exist elsewhere in the tree? Deliverable:
  the blast radius (this one site, or N sites).
- **Phase 3 — Hypothesis.** State the specific change that should fix the
  root cause and why, plus how you'll confirm it. Deliverable: one
  falsifiable hypothesis.
- **Phase 4 — Minimal fix.** Apply the smallest change that addresses the
  root cause, add/extend a test that fails before and passes after.
  Deliverable: root cause + fix + test.

## Arguments

`$ARGUMENTS` is a one-line description of what's broken. Examples:

- `test suite fails with a database connection-closed error`
- `the workspace-commit step times out on a fresh worktree`
- `PR #519 deprovision workflow leaves orphaned resources behind`

If `$ARGUMENTS` is empty, ask the user for the symptom in one
sentence. Don't start the loop on a vague brief.

## How it runs

1. **Print the brief.** Restate the bug in one line so the user sees
   you understood it correctly.

2. **Spawn the `debugger` agent** (mapped through `agents.debugger`) with
   the brief, the working directory (current cwd), and any obvious context
   (the failing test name, the production trace ID, the relevant ticket).
   Tell it to start at Phase 1 and not propose fixes until Phase 1's
   deliverable is in.

3. **Read the agent's report.** It comes back at one of these states:
   - `Phase 1 incomplete — need <data>` → either run the data
     collection yourself (run the test command from `.rig/config.json`
     (`test.command`, default `npm test`) scoped to the failing test, fetch
     logs, `git diff`) or ask the user. Then re-spawn the debugger with
     the data added.
   - `Phase 4 complete — root cause, fix, test` → done. Report to
     user with the agent's output. The fix is already in the worktree.
   - `Three fixes failed — architectural concern` → STOP. Surface the
     agent's architectural-concern note to the user. Do not spawn the
     debugger again with "try one more thing." Suggest re-scoping or
     pulling in the `architect` agent (mapped through `agents.architect`)
     for a design review.

4. **After a Phase 4 fix, hand back to the user.** Don't auto-PR.
   Debugging produces a candidate fix; the user decides whether to
   ship it.

## Anti-patterns this skill exists to prevent

- Coder agent invoked on a bug with "fix this" — coder writes a
  plausible patch with no root cause. Bug returns later.
- Multiple speculative fixes piled into one commit. Can't tell what
  worked, can't revert cleanly.
- Architectural problems repeatedly patched at the symptom layer
  until they metastasize.

## Relationship to other skills

- **Use `/rig-debug` when you don't know why something fails.** It refuses
  to guess.
- **Use an implement-style flow when you know what to build.** It assumes
  the spec is correct.
- **Use a verify flow to confirm a known-good change works end-to-end** —
  not for debugging an unknown failure.
- `/rig-debug` may end with a follow-up ticket if the fix is big enough to
  warrant one; usually it just ends with a small worktree change the user
  reviews directly.
