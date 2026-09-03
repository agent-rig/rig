---
name: rig-doctor
description: "Preflight health check for a rig project: detect things that make rig degrade or fail — missing gh auth or the project scope, an unreachable board, an invalid config, no CI gates, missing review catalog — and report each with the exact fix. Diagnose-only by default; `--fix` applies the safe fixes with confirmation. Triggers on: 'doctor', 'rig doctor', 'check my setup', 'health check', 'why isn't rig working', 'diagnose rig', 'preflight'."
argument-hint: "[--fix] — diagnose (default) or apply the safe fixes"
---

# rig-doctor — is this project set up for rig?

Inspect the environment, the tracker/board, the repo's gates, and `.rig/config.json`,
then report what would make rig run worse or fail — each finding with the exact
fix. **Read-only by default.** With `--fix`, apply the *safe* fixes after showing
them and getting a yes; leave sensitive changes (auth, branch protection) as
printed commands.

Pairs with `/rig-onboard`: onboard installs, doctor verifies.

## Output

Group findings by severity and print the fix under each:

```
rig-doctor — <project> on <branch>
  BLOCKERS (n)   … rig won't work right until these are fixed
  WARNINGS (n)   … rig runs, but ungated or degraded
  NITS (n)       … advisories
✓ when a section is clean.
```

Read `.rig/config.json` first (if absent → the only blocker is "not onboarded;
run /rig-onboard"). Everything below is gated on what the config actually uses
(e.g. skip board checks when `tracker.provider` ≠ `github` or no `tracker.board`).

## Checks

### Blockers
- **gh present + authed** — `gh --version`, `gh auth status`. Fix: install
  <https://cli.github.com> / `gh auth login`. (manual — interactive)
- **`project` scope** — when `tracker.board` is set, `gh auth status` must list
  `project`. Fix: `gh auth refresh -s project --hostname github.com`. (manual)
- **board reachable** — `gh project view <n> --owner <owner>` succeeds, and the
  adapter returns: run the resolved tracker adapter's `select --limit 1`
  (`.rig/rig-tracker` if executable, else `<RIG_DIR>/scripts/rig-tracker.sh`).
  Fix: correct `tracker.board.owner`/`projectNumber`.
- **config valid** — `.rig/config.json` parses and matches `rig.schema.json`
  (`.rig/schema.json`). `vcs.baseRef` and `vcs.defaultBranch` exist on the remote
  (`git ls-remote --heads origin <branch>`). Fix: correct the fields.
- **test command runs** — the runtime behind `test.command` is installed
  (`cargo` / `bun` / `node` per `runtime.packageManager`). Fix: install it.

### Warnings
- **CI gates** — the default branch has **required status checks** (`gh api
  repos/<repo>/branches/<default>/protection` → `required_status_checks.contexts`
  non-empty), and `.github/workflows/` has a test gate. Empty/absent → "merges
  aren't gated." Fix: add a test-gate workflow (see rig's `ci/`), then mark its
  check required. (manual — protection is sensitive)
- **shape labels exist** — on `tracker: github`, the `tracker.shapeLabels`
  values exist as repo labels (`gh label list`). *(--fix: `gh label create`.)*
- **board columns match** — `tracker.board.statusOptions` values exist as
  columns on the board (`gh project field-list`). Fix: add the columns, or
  correct the config. *(--fix: add via `gh` if missing.)*
- **review catalog** — `review.patternsFile` (default `.claude/REVIEWER.md`)
  exists. Fix: copy the template from rig `templates/`. *(--fix: copy it in.)*
- **writing-style guide** — `style.guideFile` (default `.claude/STYLE.md`)
  exists, so every agent writes PR bodies, tickets, and findings to one
  standard. Absent → "agent prose is unconstrained." Fix: copy the template from
  rig `templates/`. *(--fix: copy it in.)*
- **review bot reachable** — if `review.bot` ≠ `none`, the bot is installed on
  the repo. Fix: install it or set `review.bot: none`.

### Nits / advisories
- **auto-accept** — a skill **cannot** read the harness's mode, so this is
  advice, not a check: if you're *not* in auto-accept, epics and `rig-loop`
  pause on every edit. In Claude Code, `shift+tab` toggles it.
- **`.rig/epics/` gitignored** — it's throwaway coordination state and must not
  be committed. *(--fix: add `.rig/epics/` to `.gitignore`.)*
- **sourceScope paths exist** — each `sourceScope[i]` resolves. Fix: correct it.
- **stale epics** — `.rig/epics/*.json` whose branches are already merged/gone.

## `--fix` (opt-in)

Only when `--fix` is passed. Show the exact change and get a yes before each,
then apply **only the safe set**:
- create missing `shapeLabels` repo labels (`gh label create … --force`);
- add `.rig/epics/` to `.gitignore`;
- copy `REVIEWER.md` from the kit template if absent;
- copy `STYLE.md` from the kit template if absent;
- add missing board columns.

**Never auto-apply** (print the command instead): `gh auth …` (interactive),
branch-protection changes, creating/editing CI workflows, anything that writes
to a branch or changes permissions. Re-run diagnose after fixing.

## Notes

- Purely diagnostic without `--fix`; it reads, it doesn't change.
- Degrades: skip tracker/board checks on `tracker.provider: none`; skip GitHub
  checks on `linear`.
- Fast to re-run — good as a preflight before `/rig-plan`, `/rig-epic run`, or a
  live demo.
