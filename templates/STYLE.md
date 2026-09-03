# Writing style for agent output (starter)

Agents write a lot of prose: PR bodies, ticket descriptions, review findings,
plans, spike writeups, status hand-backs, commit messages. Humans have to read
all of it, usually in a hurry, usually while deciding something. This file is
the house style for that prose.

It follows the [Google developer documentation style
guide](https://developers.google.com/style) — the
[highlights](https://developers.google.com/style/highlights) are the short
version. Where this file and Google disagree, this file wins; where this file is
silent, Google decides.

This is a starter. Keep it, prune it, or add the conventions your team argues
about in review.

> **Scope.** Every rig persona and skill writes to this style. It governs prose,
> not code: source code follows the conventions of the code around it.

## The bar

A reader should get the answer from the first sentence, and be able to skim the
rest for the parts that concern them. If they have to reread a sentence to parse
it, rewrite the sentence.

## Rules

### 1. Lead with the answer

Put the conclusion, verdict, or decision first. Reasoning follows it. Never
narrate the path you took to get there and make the reader wait for the point.

- **Do:** `Changes requested — the new filter breaks the webhook path.`
- **Don't:** `I started by reading the diff, then traced the callers, and after
  looking at the webhook handler I came to the conclusion that there may be an
  issue with the new filter.`

### 2. One idea per sentence

Short sentences. Split a sentence that needs a comma splice, a nested
parenthetical, or a second `which` to hold itself together.

- **Do:** `The token expires after an hour. Refresh it before each retry.`
- **Don't:** `The token expires after an hour (which is configurable, though we
  don't configure it), so it needs refreshing, which the retry path should
  handle.`

### 3. Active voice, and name the actor

Say who does what. Passive voice hides the actor, which matters most in exactly
the sentences a reader needs to act on.

- **Do:** `The webhook handler calls getByToken.` / `Scope the lookup to the
  requester.`
- **Don't:** `getByToken is called by the webhook handler.` / `The lookup should
  be scoped.`

Passive is fine when the actor is genuinely irrelevant: `The migration was
applied in January.`

### 4. Present tense

Describe behavior in the present. Reserve `will` for something that genuinely
happens later.

- **Do:** `If the check fails, the job stops.`
- **Don't:** `If the check would fail, the job will then be stopped.`

### 5. Condition before instruction

State the circumstance first so a reader can skip an instruction that doesn't
apply to them.

- **Do:** `To rerun only the failing test, pass --filter.` / `If the tracker is
  Linear, link the PR as an attachment.`
- **Don't:** `Pass --filter if you want to rerun only the failing test.`

### 6. Second person and imperative

Address the reader as `you`. Give instructions as commands. Don't write about
yourself; the reader wants the work, not the worker.

- **Do:** `Run the suite before pushing.`
- **Don't:** `We should probably run the suite, and then I'll push.`

### 7. Concrete nouns, real numbers, exact locations

Vague words feel like content and carry none. Replace them with the specific
thing, and anchor claims to `file:line`, a command, a SHA, or a count.

| Instead of | Write |
|---|---|
| `a solution for handling this` | `a retry wrapper around fetchInvoice` |
| `improves performance significantly` | `cuts the query from 400ms to 30ms` |
| `several places` | `three call sites: api.ts:44, jobs.ts:91, cli.ts:12` |
| `robust`, `seamless`, `powerful` | say what it does |
| `leverage`, `utilize` | `use` |
| `functionality`, `capability` | name the function |

### 8. Cut filler

Delete words that survive their own removal: `basically`, `essentially`,
`actually`, `simply`, `just`, `very`, `quite`, `it's worth noting that`,
`please note that`, `in order to`, `at this time`, `as mentioned above`. Delete
hedge stacks too — `it seems like it might possibly be` is `it might be`, or
better, go check and say which.

### 9. No jargon, metaphor, or idiom

Readers include people who joined last week and people reading in a second
language. Write the plain thing, or define the term the first time you use it.

| Instead of | Write |
|---|---|
| `blast radius` | `affected callers` |
| `low-hanging fruit` | `the cheap fixes` |
| `boil the ocean`, `move the needle`, `circle back` | say the actual action |
| `ingest` | `import`, `load` |
| `first-class citizen` | `supported directly` |

Skip pop-culture references, jokes, and exclamation marks. Never call work
`easy`, `simple`, `obvious`, or `trivial` — if it were, nobody would be reading
your explanation of it.

### 10. Structure beats paragraphs

Three or more parallel items become a list. Comparisons become a table. Ordered
steps become a numbered list, one action per step. Keep list items
grammatically parallel and don't hide a second list inside a bullet's prose.

### 11. Formatting conventions

- Sentence case for headings: `Error handling`, not `Error Handling`.
- Serial comma: `tests, types, and lint`.
- Code font for anything typed or named in code: files, commands, flags,
  functions, config keys, values.
- Bold for UI elements the reader clicks.
- Descriptive link text: `see [the tracker adapter](…)`, never `click
  [here](…)`.
- Unambiguous dates: `2026-08-18` or `August 18, 2026`, never `08/18`.
- Expand an acronym on first use unless it's universal in this repo.

### 12. Say what you don't know

An explicit gap is useful; a confident guess costs someone an afternoon. Mark
what you couldn't verify, and separate what you observed from what you inferred.

- **Do:** `Unverified — I couldn't reproduce the timeout locally. The stack
  trace points at pool.acquire, but I have no direct evidence.`
- **Don't:** `This is caused by connection pool exhaustion.` (when it's a guess)

### 13. No self-narration, no filler courtesy

Skip the preamble, the apology, the summary of what you're about to say, and the
closing offer of further help. Skip praise for the reader's question. Report
outcomes plainly, including failures: if the suite is red, the first line says
it's red.

## Shapes for the artifacts rig produces

**Commit message.** Conventional-commit subject in the imperative, under ~72
characters, no trailing period. Add a body only when the diff doesn't already
show the *why*.

`fix(auth): scope token lookup to the requesting tenant`

**PR body.** A one-paragraph summary of what changed and why, the tracker link,
a test plan someone else could run, and the `## Architecture` note. No diff
narration — the diff is right there.

**Ticket.** Title as an imperative outcome (`Add rate limiting to /invoices`,
not `Rate limiting`). Body: goal, acceptance criteria as a checklist, files to
touch, ordered steps. Acceptance criteria must be testable — a reader has to be
able to tell whether each one is met.

**Review finding.** Severity, location, the defect, the consequence, the fix —
in that order. One finding per entry. Address the code, not the author.

> P1 — `api/invoices.ts:88`: the lookup uses the raw request ID, so any tenant
> can read another tenant's invoice. Scope it to `session.tenantId` and add a
> negative test.

**Plan.** The recommendation first, then the ordered steps, then the tradeoffs
you rejected and why. Flag decisions you need from a human as
**Decision needed:**.

**Status hand-back.** Outcome line first, then the evidence, then the next
action. Concrete state, not impressions: `tests: 412 pass, 0 fail · review: 0
P0/P1, 2 P2 deferred · PR #418 open`.

## Self-check before you send

1. Does the first sentence contain the answer?
2. Can any sentence be split, or any word cut, without losing meaning?
3. Is every claim anchored to a `file:line`, command, count, or SHA?
4. Have you marked what you didn't verify?
5. Would a new hire, reading in a second language, parse this on one pass?
