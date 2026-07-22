---
name: rig-worktree
description: "Manage isolated git worktrees: create one wired up for dev (fetch, branch from base, symlink env, install deps), list them with PR state, or safely remove merged ones. A shared bootstrap that implement-style flows can call, also usable directly. Triggers on: 'worktree', 'set up a worktree', 'new worktree', 'list worktrees', 'remove worktree', 'isolate this in a worktree', 'symlink env into worktree'."
argument-hint: "<branch> [--base <ref>] [--reuse] [--no-install] [--name <s>] | list | rm <branch|path> [--force-dirty]"
allowed-tools: [Bash, Read]
---

# Worktree — isolated dev checkout lifecycle

Create / list / remove isolated git worktrees under `.claude/rig-worktrees/`.
Creation produces a worktree that's actually ready to run: fetched from
origin, branched from the right base, env files symlinked, dependencies
installed. This is a shared bootstrap you can call directly (spikes,
ad-hoc branches, parallel experiments) and that implement-style flows and
prune/rig-tidy steps can delegate to.

The logic lives in two scripts so the invariants live in one place:
`.claude/scripts/setup-worktree.sh` (create) and
`.claude/scripts/remove-worktree.sh` (teardown). **Creation encodes
three invariants that bite if skipped** — fetch-before-branch (stale
local refs silently start you on a pre-merge tip), env symlinks (missing
secrets read as flaky/timeout test failures, not "config not found"),
and a per-worktree dependency install (installed deps don't carry across
worktrees → `Cannot find package '...'`). Don't reimplement these
inline; call the scripts.

## Configuration

Reads `.rig/config.json` (missing keys → defaults):

| Key | Default | Used for |
|---|---|---|
| `vcs.baseRef` | `origin/main` | Default `--base` the worktree branches from. |
| `vcs.branchConvention` | `{user}/{ticket}-{slug}` | Template when inferring a branch name from a ticket ID. |
| `vcs.defaultBranch` | `main` | The trunk (informational; the main worktree). |
| `runtime.installCommand` | derived from `packageManager` | Passed to the setup script as `--install-cmd`. |
| `runtime.packageManager` | `npm` | Derives the install command when `installCommand` is unset (`bun`→`bun install`, `pnpm`→`pnpm install`, `yarn`→`yarn`, `npm`→`npm install`, `none`→skip install). |
| `tracker.ticketPrefix` | — | Recognizing a ticket ID (e.g. `ABC-521`) to slot into the branch template. |

If `.rig/config.json` is absent, run unconfigured: base `origin/main`,
install `npm install`, branch template `{user}/{ticket}-{slug}`, and say so.

## Subcommands

`$ARGUMENTS` routes to one of:

- **(default — a branch name)** create/reuse a worktree. See *Create* below.
- **`list`** — show all worktrees with their branch + PR state. Read-only.
- **`rm <branch|path>`** — safely tear a worktree down (skip if dirty).

## Create — arguments

`$ARGUMENTS` is the branch name plus optional flags. The branch is the
only required argument.

- `<branch>` — branch to create/check out, e.g. `alice/feat-521-rename`
  or `feat-679-observability`. The naming convention for ticket work is
  `vcs.branchConvention` (default `{user}/{ticket}-{slug}`).
- `--base <ref>` — base to branch from. Default `vcs.baseRef`. For a
  stacked/integration child, pass `origin/<integration-branch>`.
- `--path <path>` — worktree location. Default
  `.claude/rig-worktrees/<last segment of branch>` (so `alice/feat-521-foo`
  → `.claude/rig-worktrees/feat-521-foo`).
- `--reuse` — if the worktree/branch already exists, fetch and
  hard-reset it to `<base>` instead of failing. Use this for a
  "reuse a child worktree" path.
- `--no-install` — skip the dependency install (rarely wanted; only for
  a read-only checkout).
- `--name <session-name>` — background-job/session display name. Delegates to
  `set-session-name.sh` (ships with the kit). **Claude-Code-only** — it renames
  the FleetView background-job entry so the job list reads as the work (the
  ticket/epic) instead of the raw prompt; a clean no-op on any other agent.
- `--skip-if-prefix <p>` — passed through to `set-session-name.sh`; leave an
  existing name in place if it starts with `<p>` (so an `EPIC:` label set by
  `rig-epic` wins over a per-child `FEAT:`/`CHORE:` label).

## Create — procedure

1. **Read `.rig/config.json`** for `vcs.baseRef`,
   `vcs.branchConvention`, and the install command. Derive the install
   command from `runtime.installCommand`, else from
   `runtime.packageManager`.

2. **Infer the branch if not given.** If `$ARGUMENTS` is empty:
   - If the current branch matches the ticket-work convention, offer to
     reuse / recreate it. Otherwise ask the user for a branch name or
     ticket ID. Don't guess a branch out of thin air.
   - If given a ticket ID (e.g. `<ticketPrefix>521`) with no slug, build
     the branch from `vcs.branchConvention`, substituting `{user}` (git
     user), `{ticket}` (the lowercased ID), and `{slug}` (a short kebab
     from the ticket title — fetch it if you have a tracker, else ask).

3. **Run the script** from the repo root, passing the resolved base and
   install command:

   ```bash
   "$(git rev-parse --show-toplevel)/.claude/scripts/setup-worktree.sh" \
     <branch> [--base <baseRef>] [--install-cmd "<install cmd>"] [--reuse]
   ```

   The script prints progress to stderr and the **absolute worktree
   path as the last line of stdout**, so capture it:

   ```bash
   WT=$("$(git rev-parse --show-toplevel)/.claude/scripts/setup-worktree.sh" \
     alice/feat-521-rename --base origin/main --install-cmd "bun install" | tail -1)
   ```

   (The script also honors `WORKTREE_BASE_REF` and `WORKTREE_INSTALL_CMD`
   env vars, so you can export those from config instead of passing flags.)

4. **Report back** the worktree path, the branch, and the base it was
   cut from. If the caller is a human running this directly, remind them
   they can `cd "$WT"` to work there. If the script failed (e.g. path
   exists without `--reuse`), surface the error verbatim and suggest
   `--reuse`.

## `list`

Show every worktree with the branch it has checked out and, where one
exists, the state of its PR. Read-only — never removes anything.

```bash
git worktree list --porcelain
```

For each non-main worktree, resolve its branch and look up the PR
state so the user can see what's safe to prune:

```bash
gh pr list --head <branch> --state all --json number,state,title -q '.[0] // empty'
```

Report a table: worktree path · branch · PR # · PR state (OPEN /
MERGED / CLOSED / none) · dirty? (`git -C <path> status --porcelain`).
End with a one-line hint, e.g. *"2 worktrees on MERGED branches —
`/rig-worktree rm <branch>` to reclaim them."*

## `rm <branch|path>`

Safely tear a worktree down via the shared script. Dirty worktrees are
**skipped, not removed** (a skip is a normal outcome, not an error) —
pass `--force-dirty` to override.

```bash
"$(git rev-parse --show-toplevel)/.claude/scripts/remove-worktree.sh" \
  <branch|path> [--force-dirty] [--keep-branch]
```

The first stdout token is the outcome: `removed <path>`,
`skipped <path>` (dirty), or `absent <arg>` (no such worktree). The
script deletes the branch too (force `-D`, since a squash/rebase-merged
PR leaves the local branch unmerged); pass `--keep-branch` to retain it.

Report what was removed, skipped (with the dirty reason), or absent.

## Notes

- The scripts resolve the **main** worktree (first entry of `git
  worktree list`) as the source for env files / ignores and as the
  place to run `git worktree` commands, so they're safe to invoke from
  inside another worktree. `remove-worktree.sh` refuses to remove the
  main worktree.
- Symlinks (not copies) — editing an env file in the main repo
  propagates to every worktree. `ln -sfn` is idempotent, so re-running
  create with `--reuse` re-links cleanly.
