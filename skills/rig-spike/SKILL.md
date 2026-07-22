---
name: rig-spike
description: "Run a time-boxed research spike to answer an open technical question or de-risk an approach BEFORE committing to implementation. Produces written findings + a recommendation (and optionally a throwaway prototype), not production code. Use when the team needs to evaluate feasibility, compare options, or reduce uncertainty before a feature is planned. Triggers on: 'spike', 'research spike', 'investigate', 'evaluate feasibility', 'de-risk', 'proof of concept', 'POC', 'compare options', 'can we', 'what would it take'."
argument-hint: "[<QUESTION-OR-TICKET-ID>] | [create <QUESTION>] | (no args = ask for the question)"
---

# Research Spike

A spike is a **time-boxed investigation** whose deliverable is *knowledge*,
not shipped code. You answer a specific question, surface the trade-offs,
and recommend a path — so the team can plan implementation with confidence
instead of guessing.

Use a spike when the work is *uncertain*: feasibility is unknown, there are
multiple viable approaches, an unfamiliar API/library is in play, or scope
can't be estimated until something is prototyped. If the path is already
clear and it's just work to be done, skip the spike and go straight to
implementation planning.

## Configuration

Reads `.rig/config.json`:

- `sourceScope[0]` — the default code scope explorers map first
  (default: `src`).
- `tracker.provider` — `linear` | `github` | `none` (default: `none`).
  When `none`, skip all tracking-ticket steps and deliver the writeup in
  chat only. When set, optionally create a `Spike:` tracking ticket and
  post findings back to it.
- `tracker.team` / `tracker.project` — where a Linear tracking ticket is
  filed, when the provider is `linear`.
- `agents.architect` — the project's name for the canonical `architect`
  role (default: `architect`). `Explore` and `Plan` are Claude Code
  built-ins and are used as-is.

If the file is absent, use the defaults above (treat the tracker as
`none`) and note you're running unconfigured.

**Core rules of a spike**

- **Time-box it.** Decide the budget up front (default: half a day / ~4h
  of effort). The goal is *enough* signal to decide, not a complete build.
- **The output is a writeup, not a PR.** Any code is throwaway prototype
  used to learn — it does not get merged. Mark prototype branches clearly
  and don't open a PR-to-trunk from them.
- **End with a recommendation and concrete next steps** (usually: tickets to
  create, or a "don't do this" with the reason).
- **Be honest about what you couldn't verify.** Lead with the verdict, back
  it with evidence, and mark anything you can't support with `file:line` (or a
  run/probe result) as `unverifiable` — never pad a recommendation with
  confidence you didn't earn.
- **Pin the codebase state.** Record the commit SHA you investigated against
  (`git rev-parse HEAD`) plus the date, so the recommendation is reproducible
  and its staleness is obvious once the trunk moves on.

## Arguments

The user invoked this with: $ARGUMENTS

## What to do

### If no question was given (empty `$ARGUMENTS`)

Ask the user for the spike question and, ideally, what decision it unblocks.
A good spike question is specific and answerable ("Can we stream logs over
SSE without exceeding the gateway idle timeout?"), not open-ended ("look
into logging"). Confirm the time-box before starting.

### If the user gave a question (or `create <QUESTION>`)

1. **Frame the spike.** Restate it as:
   - **Question** — the one thing this spike answers.
   - **Decision it unblocks** — what the team does differently based on the
     answer.
   - **Time-box** — effort budget (default ~4h; confirm with the user).
   - **Done-when** — the specific signal that ends the spike (e.g. "we know
     whether approach A is viable and roughly how many tickets it implies").

2. **Optionally create a tracking ticket** so the work is visible — only if
   `tracker.provider` is not `none`. Skip this step entirely when the tracker
   is `none`.
   - For `linear`: `mcp__claude_ai_Linear__save_issue`, using
     `tracker.team` and `tracker.project` from the profile.
   - For `github`: open a tracking issue with `gh issue create`.
   - title: prefix with `Spike:` ("Spike: SSE streaming feasibility")
   - state: "Todo" / backlog
   - labels: add a `spike`/`research` label if one exists
   - description: the Question / Decision / Time-box / Done-when frame above.
   - Do this when the spike is non-trivial or others need visibility; skip
     for a quick inline investigation.

3. **Investigate.** First pin the codebase: capture
   `git rev-parse HEAD` + today's date for the findings header (all
   code-grounded claims are "as of" this SHA). Then run research in parallel —
   this is fan-out work:
   - Spawn `Explore` agents to map how the relevant code works today
     (start with the default source scope from `.rig/config.json`
     (`sourceScope[0]`), then any infra/adjacent packages) and find prior art.
   - Spawn the `Plan` or `architect` agent (the latter mapped through
     `agents.architect`) to sketch candidate approaches and their trade-offs.
   - Force a **structured return** from each fan-out agent so findings stay
     comparable and evidence-backed — e.g.
     `{ finding, evidence: [{file:line, quote}], confidence: high|med|low }`
     from explorers, and `{ approach, buildable: yes|no|with-caveats,
     files_to_touch, effort: S|M|L, risks }` from the planner.
   - `WebFetch` / `WebSearch` for unfamiliar APIs, library docs, or version
     constraints — **read the docs before guessing semantics** (guessing at
     API behavior has cost real PRs).
   - If a prototype is needed to learn, build the *smallest* throwaway one.
     Keep it on a clearly-named scratch branch; do **not** open a PR to the
     trunk.

4. **Verify the risky assumptions.** Don't stop at "this looks possible."
   Decompose the recommendation into the discrete claims it depends on (a
   timeout holds, an API supports X, a migration is reversible, the current
   code does Y), then prove each one — run the probe, hit the endpoint, read
   the code. Give every claim an explicit verdict with evidence:

   | Claim | Verdict | Evidence | Confidence |
   |-------|---------|----------|------------|
   | … | confirmed / refuted / partially-true / **unverifiable** | `file:line` or probe result | high/med/low |

   Mark anything you genuinely couldn't check as `unverifiable` rather than
   guessing — an honest gap is more useful than a padded verdict, and it
   becomes an open question below.

5. **Write the findings.** Produce a concise writeup with these sections:

   - **Header** — the question under test, the time-box, and the pinned
     codebase state (`SHA` + date) the claims were checked against.
   - **Question & answer** — lead with the verdict (Yes / No / It depends,
     and the one-line why).
   - **What was investigated** — what you read, ran, and prototyped.
   - **Findings** — the per-claim verdict table from step 4 (evidence +
     confidence), making explicit what you verified vs. left `unverifiable`.
   - **Options & trade-offs** — a table when there's more than one path:

     | Option | Effort | Risk | Notes |
     |--------|--------|------|-------|

   - **Recommendation** — the path you'd take and why.
   - **Next steps** — concrete follow-up tickets (titles + one-liners), or an
     explicit "do not pursue, because …".
   - **Open questions** — anything still unknown that a later spike or the
     implementation would need to resolve.

   If a tracking ticket was created in step 2, post the writeup back to it
   (`mcp__claude_ai_Linear__save_comment` for Linear, `gh issue comment` for
   GitHub). Surface it in chat regardless.

6. **Hand off.** Based on the recommendation, point the user at the right
   next step:
   - Clear single path → implement a single new ticket.
   - Several independent pieces → plan a sprint of independent tickets.
   - Interleaved pieces with a shared runtime contract → plan an epic on a
     shared integration branch.
   - Not worth doing → say so plainly and close the spike ticket.

   Do **not** auto-create the implementation tickets or start coding — a
   spike ends at the recommendation. The user decides whether to proceed.

### If the user passed a ticket identifier (e.g. ABC-123)

Only applicable when `tracker.provider` is not `none`.

1. Fetch it (`mcp__claude_ai_Linear__get_issue` for Linear, `gh issue view`
   for GitHub) to read the spike's framing.
2. Run steps 3–6 above against that ticket, posting the findings back as a
   comment and moving it to the appropriate state when done.
