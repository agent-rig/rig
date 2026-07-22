# Label mapping (starter)

Single source of truth mapping change *type* and *area* to PR / issue labels.
`rig-issue` and `rig-task` read this (via `tracker.labelMapFile` in
`.rig/config.json`); if it's absent they skip label logic. Edit for your project;
if you run the `label-pr` CI workflow, keep this in sync with `.github/labeler.yml`.

## By conventional-commit type (from the PR/commit title)

| Title prefix | Label |
|---|---|
| `feat:` | `feature` |
| `fix:` | `bug` |
| `chore:` / `refactor:` / `test:` / `docs:` / `perf:` | `chore` |

## By changed area (from the touched paths)

| Path glob | Label |
|---|---|
| `docs/**`, `**/*.md` | `docs` |
| `.github/**` | `ci` |
| `**/*.test.*`, `test/**` | `tests` |
| _security-/auth-/secret-sensitive paths_ | `security` |

> Delete rows you don't use and add your own. The point is that labels are
> applied deterministically from title + paths, not hand-picked per PR.
