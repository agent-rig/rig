# pi persona frontmatter

These `.yml` files are **frontmatter only**. The persona *body* — the actual
system prompt — lives once, in `agents/<name>.md` at the kit root, and is shared
by every target. Nothing here duplicates it.

At install time the `pi` target assembles each persona:

```
.pi/agents/<name>.md  =  "---\n" + pi/agents/<name>.yml + "---\n" + <body of agents/<name>.md>
```

where `<body>` is everything after the closing `---` of the source file's own
frontmatter. `install.sh` does this (see `assemble_pi_agent`); the `rig-onboard`
skill does the same thing when it delivers the files itself.

## Why the frontmatter differs

Claude Code and `pi-subagents` describe an agent with different keys, so only
this layer is target-specific:

| `agents/*.md` (Claude Code) | `pi/agents/*.yml` (pi-subagents) | Note |
|---|---|---|
| `tools: Read, Write, Edit, Bash, Grep, Glob` | `tools: read, write, edit, bash, grep, find` | pi's built-ins are lowercase; `Glob` → `find` |
| `tools: … WebFetch, WebSearch, TodoWrite, LSP` | *(dropped)* | no pi built-in equivalent; the bodies already treat LSP as "when available" and fall back to grep |
| `tools: … Task` | *(dropped)* | children don't delegate — the parent session stays the orchestrator |
| `model: opus` / `model: sonnet` | `thinking: high` / `thinking: medium` | rig's model tier is Claude-specific; thinking level carries the same intent on any provider. See `docs/pi.md` to pin real models per role. |
| — | `systemPromptMode: replace` | the body *is* the whole system prompt, not an addition to pi's default |
| — | `inheritProjectContext: true` | personas need `AGENTS.md` + `.rig/config.json` in view |
| — | `inheritSkills: false` | personas are self-contained; the parent invokes skills |
| — | `intercom` in `tools` | lets a child surface a "Decision needed" to the parent instead of guessing (omitted for `rig-qa`, which has no escalation path) |

Keep the `name` and `description` byte-identical to the source persona — they're
what the model matches on when picking an agent, and drift between targets means
the same role behaves differently depending on which harness you're in.
