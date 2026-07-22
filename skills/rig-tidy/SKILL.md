---
name: rig-tidy
description: "Run post-merge code cleanup: audit recent changes for dead code, duplicates, and stale comments, then safely remove them. Triggers on: 'cleanup', 'simplify', 'clean up code', 'remove dead code', 'post-merge cleanup'."
argument-hint: "[scope] [commits]"
allowed-tools: [Bash, Read, Glob, Grep, Edit, Write, Agent]
---

# Post-Merge Cleanup

Audit and clean up the diff from the last N commits. Catches dead code,
unused imports, stale comments, and obvious duplicates that slipped in
during rapid development.

## Configuration

Reads `.rig/config.json`:

- `sourceScope[0]` — the default directory to audit when no scope is
  given (default: `src`).
- `test.command` — the suite run in the verify step (default: `npm test`).
- `agents.reviewer` — the project's name for the canonical `reviewer`
  role (default: `reviewer`).

If the file is absent, use the defaults above and note you're running
unconfigured.

## Arguments

The user invoked this with: $ARGUMENTS

## What to do

1. **Parse the arguments.**
   - **scope**: directory to audit (default: the default source scope from
     `.rig/config.json` (`sourceScope[0]`, default `src`)).
   - **commits**: number of recent commits to review (default: `10`)

   Examples:
   - `/rig-tidy` → default scope, 10 commits
   - `/rig-tidy path/to/dir 5` → that directory, 5 commits
   - `/rig-tidy 20` → default scope, 20 commits

2. **Show what will be audited.**
   ```bash
   git log --oneline -${commits}
   git diff HEAD~${commits} --stat -- ${scope} | tail -20
   ```

3. **Audit the diff via a fresh-context subagent.** Spawn a `reviewer`
   agent (mapped through `agents.reviewer`) with this prompt (don't do the
   audit inline — the implementer context is too close to the code to spot
   dead-on-arrival abstractions):

   > "Audit the diff `git diff HEAD~${commits} -- ${scope}` for
   > cleanup candidates. Categories: (a) dead code — exported symbols
   > with no callers in the tree, internal helpers used once; (b)
   > unused imports; (c) stale comments — TODOs completed by the diff,
   > comments describing prior behavior, doc lines that no longer
   > match the code; (d) duplicates — near-identical helpers, repeated
   > inline expressions that could collapse; (e) inconsistencies —
   > naming drift, mixed patterns introduced during the window.
   >
   > For each finding give file:line, the category, one-line
   > justification, and the proposed deletion or merge. Skip anything
   > you're not confident about. If the window is clean, say so."

4. **Apply the high-confidence findings.** For each item the reviewer
   flagged with concrete file:line + proposed edit, apply the Edit.
   Skip anything ambiguous and surface it to the user instead.

5. **Verify.** Run the test command from `.rig/config.json`
   (`test.command`, default `npm test`):
   ```bash
   <test.command>
   ```
   If anything fails, revert the offending edits (`git checkout -- <file>`)
   and report which removal broke tests so the user can decide whether
   to keep or rework.

6. **Report.** Lines removed, files touched, anything skipped and why.
