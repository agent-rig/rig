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
| `labelMapFile` | `.claude/label-mapping.md` | PR/tracker label source of truth. On an install without the `claude-code` target the doc lives at `.rig/label-mapping.md`, and the installer writes that path instead. |
| `githubIntegration` | `false` | If true, GitHub drives PR/merge transitions (In Progress on PR-open, In Review, Done on merge); skills set only the start-of-work In Progress, which GitHub can't observe before a PR exists. |

## `review`
| Key | Default | Meaning |
|---|---|---|
| `patternsFile` | `.claude/REVIEWER.md` | The P0–P3 review catalog. On an install without the `claude-code` target the catalog lives at `.rig/REVIEWER.md`, and the installer writes that path instead. |
| `bot` | `none` | `codex`\|`claude`\|`bugbot`\|`none`. Which PR bot `rig-review fix` polls/re-triggers. |
| `botRetrigger` | — | Comment that re-triggers the bot, e.g. `@codex review`. |
| `maxRounds` | `5` | Max fix↔re-review rounds before handing to a human. |

## `style`
| Key | Default | Meaning |
|---|---|---|
| `guideFile` | `.claude/STYLE.md` | The house style for prose agents write — PR bodies, tickets, review findings, plans, hand-backs. Rig ships a starter based on the [Google developer documentation style guide](https://developers.google.com/style). Every persona reads it before writing; the rules also hold inline if the file is missing. `rig-proof` walks it against a draft, and `scripts/check-style.ts` harvests its banned-term lists to grep for mechanically — so the guide is the only place style rules live. |

## `design`
| Key | Default | Meaning |
|---|---|---|
| `provider` | `none` | `figma`\|`none`. `none` strips the design-to-ticket flow (`rig-design`) entirely. |
| `defaultFileKey` | — | Figma file key used when `rig-design` is invoked with a bare frame reference instead of a full URL. |

## `dev`
Consumed by `rig-preview` (Step 6.5 of `rig-task`) to boot a running, seeded
environment for manual QA. Absent entirely → `rig-preview` reports manual
preview isn't configured and stops, rather than guessing commands.
| Key | Default | Meaning |
|---|---|---|
| `dbCommand` | `none` | Command to start a local database, if any. |
| `backendCommand` | `none` | Command to start a backend/API server, if any. |
| `frontendCommand` | — | Command that serves the app (bundler/dev server). The only field `rig-preview` actually requires. **Must contain a literal `{port}`** (e.g. `"npx expo start --port {port}"`) — without it, the command falls back to its own default port and can collide with another worktree's preview even though their configured ports differ. |
| `frontendPort` | `8081` | Port `frontendCommand` binds. `rig-preview` refuses to reuse a port held by another live worktree's preview rather than killing it blind. |
| `mobileBuildCommand` | — | Mobile apps only: builds and installs a native binary onto a specific simulator device. **Must contain a literal `{device}`** (e.g. `"npx expo run:ios --device {device}"`). Run on every preview, not just the first — a deep-link reconnect to an already-installed binary was tried and found unreliable, so a full build+install per worktree is the default. |
| `seedCommand` | `none` | Command to seed local data. Absent → `rig-preview` reports the gap instead of inventing a seed script. |

## `agents`
Optional map from the kit's canonical role → the agent name registered in your
project. Defaults to the kit's own agents, `rig-<role>` (e.g. `debugger`→
`rig-debugger`, `designer`→`rig-ui-ux-designer`). Only set a value to point a
role at a differently-named agent.

## `ci`
Only relevant if you installed workflows from `ci/`. Each installed workflow
documents which of these it reads.
| Key | Default | Meaning |
|---|---|---|
| `imageRegistry` | `ghcr.io` | Registry for the generic image-build workflow. |
| `slackWebhookSecret` | `SLACK_CI_WEBHOOK_URL` | Secret name for the CI Slack webhook. |
| `trustBoundaryPaths` | — | Paths that trip the deeper security-scan gate. |
