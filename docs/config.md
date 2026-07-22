# The project profile (`.rig/config.json`)

Every parameterizable skill reads this file at runtime. It lives at
`.rig/config.json` in the consuming project. All keys are optional; missing
keys fall back to the defaults below. The machine-readable schema is
`rig.schema.json`; a filled reference is `rig.config.example.json`.

> **How skills consume it.** A skill's `SKILL.md` says, in effect, "read
> `.rig/config.json`; use `test.command` for the test step, `vcs.baseRef`
> for the diff base," etc. If the file is absent, the skill uses the defaults and
> notes that it's running unconfigured.

## `project`
| Key | Default | Meaning |
|---|---|---|
| `name` | — | Human project name, used in prose. |
| `repo` | (git origin) | `owner/name` for `gh api` calls in review/CI skills. |

## `runtime`
| Key | Default | Meaning |
|---|---|---|
| `packageManager` | `npm` | `bun`\|`pnpm`\|`npm`\|`yarn`\|`none`. Selects install command and CI setup action. |
| `installCommand` | derived | Override the derived install command. |

## `test`
| Key | Default | Meaning |
|---|---|---|
| `command` | `npm test` | Unit-test suite. Used by rig-debug, rig-tidy, rig-review, rig-worktree, rig-task, CI test-gate. |
| `integrationCommand` | — | Integration-only command, if separate. |
| `e2eCommand` | — | End-to-end command, if any. |
| `requiresDatabase` | `false` | If true, the CI test-gate spins up a throwaway Postgres. |

## `sourceScope`
Array of path globs. The first entry is the default scope for `rig-tidy`,
`rig-spike`, and `rig-sprint` when no path is given. Default `["src"]`.

## `vcs`
| Key | Default | Meaning |
|---|---|---|
| `defaultBranch` | `main` | Trunk. |
| `baseRef` | `origin/main` | What `rig-review` diffs against and worktrees branch from. |
| `branchConvention` | `{user}/{ticket}-{slug}` | New-branch template. Placeholders `{user}`, `{ticket}`, `{slug}`. |
| `protectedBranchMergeQueue` | `false` | If true, use `gh pr merge --auto` and never pass `--rebase`/`--squash`. |

## `tracker`
Set `provider: "none"` to strip all ticket steps from `ticket`/`sprint`/review flows.
| Key | Default | Meaning |
|---|---|---|
| `provider` | `none` | `linear`\|`github`\|`none`. |
| `team` | — | Linear team name/key or GitHub org. |
| `project` | — | Linear project name. |
| `ticketPrefix` | — | e.g. `INC-`; detects ticket IDs in branches/PR titles. |
| `labelMapFile` | `.claude/label-mapping.md` | PR/tracker label source of truth. |
| `githubIntegration` | `false` | If true, the tracker auto-transitions state from GitHub events — skills must NOT set states manually. |

## `review`
| Key | Default | Meaning |
|---|---|---|
| `patternsFile` | `.claude/REVIEWER.md` | The P0–P3 review catalog. |
| `bot` | `none` | `codex`\|`claude`\|`none`. Which PR bot `rig-review fix` polls/re-triggers. |
| `botRetrigger` | — | Comment that re-triggers the bot, e.g. `@codex review`. |
| `maxRounds` | `5` | Max fix↔re-review rounds before handing to a human. |

## `agents`
Optional map from the kit's canonical role → the agent name registered in your
project. Defaults to the kit's own agents, `rig-<role>` (e.g. `debugger`→
`rig-debugger`). Only set a value to point a role at a differently-named agent.

## `ci`
Only relevant if you installed workflows from `ci/`. Each installed workflow
documents which of these it reads.
| Key | Default | Meaning |
|---|---|---|
| `imageRegistry` | `ghcr.io` | Registry for the generic image-build workflow. |
| `slackWebhookSecret` | `SLACK_CI_WEBHOOK_URL` | Secret name for the CI Slack webhook. |
| `trustBoundaryPaths` | — | Paths that trip the deeper security-scan gate. |
