---
name: rig-issue
description: "Create, view, move, or manage tickets in the project's issue tracker (Linear, GitHub Issues, or none). Triggers on: 'ticket', 'create ticket', 'move ticket', 'ticket board', 'show tickets', 'list tickets'."
argument-hint: "[action] [args] — e.g. 'create Add login page', 'move ABC-18 done', 'board', 'show ABC-18'"
---

# Ticket Manager

Manage tickets in whatever issue tracker the project is bound to. The
tracker is **config-driven** — read `.rig/config.json` first and
dispatch on `tracker.provider`. Never hardcode a team or project name.

## Configuration

Reads `.rig/config.json` (missing keys → defaults):

| Key | Default | Used for |
|---|---|---|
| `tracker.provider` | `none` | `linear` \| `github` \| `none`. Selects the backend. |
| `tracker.team` | — | Linear team name/key, or GitHub org, scoping list/create. |
| `tracker.project` | — | Linear project name for list/create. |
| `tracker.ticketPrefix` | — | Identifier prefix (e.g. `ABC-`) to recognize IDs. |
| `tracker.labelMapFile` | `.claude/label-mapping.md` | Label source-of-truth for create. |
| `tracker.githubIntegration` | `false` | If true, do NOT manually move states (see below). |

**If `tracker.provider` is `none`:** this skill can't run. Explain that
ticket management needs a tracker, and point the user at
`.rig/config.json` → set `tracker.provider` to `linear` or `github`
(with `team`/`project`). Stop there.

## Arguments

The user invoked this with: $ARGUMENTS

## Actions

Parse the user's request as one of the actions below. Each action lists
the Linear and GitHub form — use the one matching `tracker.provider`.

### `board` or `list` (default if no args)

- **Linear:** `mcp__claude_ai_Linear__list_issues` with `project` =
  `tracker.project`, `team` = `tracker.team`, `limit: 100`.
- **GitHub:** `gh issue list --limit 100 --json number,title,state,labels`
  (add `--repo <org/repo>` from `project.repo` if not in-repo).

Display results grouped by status (Backlog, Todo, In Progress, In
Review, Done — or GitHub's open/closed with labels). If the result is
truncated (a full cursor page came back), say so and offer to page
rather than silently showing a partial board.

### `show <id>`

- **Linear:** `mcp__claude_ai_Linear__get_issue` with the identifier
  (e.g. `<ticketPrefix>18`).
- **GitHub:** `gh issue view <number> --json ...`.

### `create <title>` or `new <title>`

- **Linear:** `mcp__claude_ai_Linear__save_issue` with
  `team` = `tracker.team`, `project` = `tracker.project`, `title` = the
  provided title, `state: "Backlog"`, `priority: 3` (Normal).
- **GitHub:** `gh issue create --title "<title>"` (with `--repo` if
  needed).

**Labels:** if `tracker.labelMapFile` exists, read it and apply the
mapping — typically one **type** label (feature/bug/chore, from the
work's intended conventional-commit type) **plus any area** labels the
work will touch. This is the same mapping a deterministic PR labeler
would apply to the eventual PR, so the ticket and PR agree. If the file
is **absent, skip label logic gracefully** — create the ticket without
labels and note that no label map was found.

Then ask the user if they want to add a description. If yes, update the
issue (Linear: `save_issue` with `id` + `description`; GitHub:
`gh issue edit <number> --body ...`).

### `move <id> <status>`

**Guard — `tracker.githubIntegration`:** if true, a GitHub integration
auto-transitions tracker state from branch/PR events. In that case do
**NOT** move states manually — explain that state is driven by GitHub
activity (open a branch/PR to advance it) and skip the transition. This
preserves the origin's "don't move states by hand" rule behind the flag.

Otherwise, map the requested status:
- backlog → "Backlog"
- todo/ready → "Todo"
- in-progress → "In Progress"
- review → "In Review"
- done → "Done"
- canceled → "Canceled"

- **Linear:** `mcp__claude_ai_Linear__save_issue` with `id` + `state`.
- **GitHub:** GitHub Issues have only open/closed —
  `gh issue close`/`gh issue reopen`, and reflect finer status via
  labels/project fields if the repo uses them.

### `edit <id>`

Fetch the issue, show it to the user, let them describe changes, then
update (Linear: `save_issue`; GitHub: `gh issue edit`).

### `deps <id>`

Fetch the issue and show its blocking/blocked-by relations. (Linear
exposes these natively; on GitHub, surface any "blocked by #N" text or
task-list references.)

## Priority Mapping

When setting priority (Linear numeric priority):
- critical/urgent → 1
- high → 2
- medium/normal → 3
- low → 4

On GitHub, express priority via labels if the repo defines them; skip
otherwise.
