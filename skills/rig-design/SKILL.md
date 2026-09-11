---
name: rig-design
description: "Turn a ready Figma design into a filed ticket, ready for rig-task to implement. Reads a Figma file/frame link via the Figma MCP, extracts it into a spec through rig-ui-ux-designer, decomposes and files it through rig-architect. Does not implement — hand off to rig-task/rig-sprint/rig-epic for that. Triggers on: 'the figma design is ready', 'file a ticket from this figma link', 'turn this design into a ticket', 'implement this figma frame'."
argument-hint: "<figma-url> — a Figma file or frame link"
---

# rig-design — turn a Figma design into a filed ticket

Bridges a finished design to the rest of the kit: extract it, decompose it,
file it. Implementation is a separate step (`/rig-task` on the resulting
ticket) so this skill's only job is turning a design into something
`rig-architect` can plan from.

## Configuration

Reads `.rig/config.json` (defaults in parentheses):

- `design.provider` — `figma` | `none` (`none`). `none` → stop immediately;
  this skill has nothing to do without a design source configured.
- `design.defaultFileKey` — used only if `$ARGUMENTS` is a bare frame
  reference instead of a full URL.
- `agents.designer` (default `rig-ui-ux-designer`) — extracts the spec.
- `agents.architect` (default `rig-architect`) — decomposes + files the ticket.
- `tracker.provider` — read indirectly, via `agents.architect`'s own ticket-
  filing step. This skill never talks to the tracker directly.

**Unconfigured fallback:** if `design.provider` is absent or `none`, stop and
tell the user to set it (and connect the Figma MCP) rather than guessing.

## Steps

1. **Resolve the input.** `$ARGUMENTS` should be a Figma URL with a
   `?node-id=...` — a bare file link isn't enough for the extraction tools.
   If it's missing entirely, ask for one. If it's a file link with no
   node ID, let `agents.designer` list the file's pages/frames and confirm
   which one before extracting — don't guess a frame.
2. **Check the Figma MCP is actually connected.** If the `mcp__figma__*`
   tools aren't available in this session, stop and say so — tell the user
   to connect it (`/mcp` after `claude mcp add --transport http figma
   https://mcp.figma.com/mcp`) rather than failing deep into the flow.
3. **Extract — spawn `agents.designer`** with the resolved URL. It returns
   the Markdown spec described in its own persona file. Do not proceed if it
   reports the file/frame couldn't be fetched (bad URL, no access) — surface
   that plainly.
4. **Decompose and file — spawn `agents.architect`** with the extracted spec
   as its input spec, exactly as `rig-plan` would with a written spec file.
   Architect creates the ticket on the configured tracker (or returns
   structured Markdown if `tracker.provider` is `none`) — this skill doesn't
   duplicate that logic.
5. **Report.** Print the ticket ID/link (or the Markdown plan, if no
   tracker), and the exact next command: `` /rig-task start <ticket-id> ``.
   Don't start implementation yourself — that's a separate, explicit step.

## What this skill deliberately doesn't do

- It doesn't implement anything — no `rig-coder` invocation here.
- It doesn't compare the built screen against the design after the fact —
  that's a `rig-review`-time check once the PR exists, not this skill's job.
- It doesn't poll Figma for changes. The trigger is always a human saying
  "this design is ready" with a link; there's no watcher.
