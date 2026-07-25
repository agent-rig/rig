// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-task — implement one unit end-to-end
// smithers-description: Canonicalizes the /rig-task skill as a durable graph — load spec, spec review, TDD (RED -> GREEN -> REFACTOR), pre-PR self-review gate, open PR, then the review-bot loop. Never auto-merges.
// smithers-tags: rig, implement, tdd, review
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

/**
 * Role → model, matched to the user's own agent specs in .claude/agents/rig-*.md
 * (rig-architect/rig-reviewer = opus, rig-qa/rig-coder = sonnet). Single Claude
 * model per role — deliberately NOT the codex/fable-leading pools in agents.ts,
 * which are more aggressive than the rig specs. `coord` covers orchestration
 * steps (worktree, git/gh, tracker) that have no rig role → conservative sonnet.
 */
const ROLE = {
  architect: providers.claudeOpus, // rig-architect → opus
  reviewer: providers.claudeOpus, // rig-reviewer → opus
  qa: providers.claudeSonnet, // rig-qa → sonnet
  coder: providers.claudeSonnet, // rig-coder → sonnet
  coord: providers.claudeSonnet, // orchestration/coordination (no rig spec)
} as const;

/**
 * Canonical graph of the /rig-task skill (.claude/skills/rig-task/SKILL.md).
 *
 * Smithers owns the deterministic control flow + durability; each node is a
 * coding agent that executes one step of the skill against the live repo
 * (worktree, git, gh, the Linear MCP, `.rig/config.json`). The skill file is
 * the per-node spec — prompts point back at it so the two never drift.
 *
 *   preflight -> setup -> [spec-architect | spec-qa] -> (approve-spec?)
 *     -> RED -> GREEN(loop x3) -> REFACTOR
 *     -> self-review(loop) -> open-PR        (start phase, steps 1-5)
 *     -> review-bot loop -> result           (finish phase, steps 6-7)
 */

const inputSchema = z.object({
  target: z
    .string()
    .default("")
    .describe('Ticket id (e.g. "CEX-123") OR a quoted ad-hoc "<description>". Empty = infer from the current branch.'),
  phase: z
    .enum(["start", "finish", "both"])
    .default("both")
    .describe("start = steps 1-5 (up to an open PR); finish = steps 6-7 (drive review to clean); both = one continuous run."),
  base: z
    .string()
    .default("")
    .describe("Stacked base ref to branch from and target the PR at, instead of vcs.baseRef (e.g. an epic integration branch). Empty = config default."),
  local: z
    .boolean()
    .default(false)
    .describe("Force the local /rig-review fix loop in the finish phase even when a cloud auto-fix workflow is enabled."),
  autoMerge: z
    .boolean()
    .default(false)
    .describe("Enable auto-merge: after the self-review is clean, squash-merge the PR (`gh pr merge --squash --auto`) so it lands once any required checks pass — or directly if there are none. Children always squash-merge; a configured merge queue wins. Default false → never auto-merges."),
  specGate: z
    .boolean()
    .default(true)
    .describe("When false, suppress the pre-coding spec-review APPROVAL gate (spec review still runs, non-blocking). /rig-epic sets this false for children — it front-loads ONE spec approval for the whole epic, and a child that paused mid-run would fail the parent Subflow."),
  specNotes: z
    .string()
    .default("")
    .describe("Free-form direction from the caller (e.g. /rig-epic's front-loaded spec gate) resolving spec ambiguities. Folded into the spec the coder works from."),
  prNumber: z
    .number()
    .int()
    .optional()
    .describe("Open PR number to resume from when phase=finish is run on its own."),
});

const outputSchema = z.object({
  outcome: z.string().describe('One of: "pr-open", "clean", "actionable", "timeout", "blocked".'),
  unit: z.string(),
  prUrl: z.string(),
  testsGreen: z.boolean(),
  reviewState: z.string(),
  summary: z.string(),
});

const { Workflow, Sequence, Parallel, Task, Loop, Branch, Approval, UI, smithers, outputs } = createSmithers({
  input: inputSchema,
  result: outputSchema,
  preflight: z.object({
    unit: z.string(),
    isAdHoc: z.boolean(),
    baseRef: z.string(),
    testCommand: z.string(),
    trackerProvider: z.string(),
    ticketPrefix: z.string(),
    reviewBot: z.string(),
    maxRounds: z.number().int(),
    defaultBranch: z.string(),
    summary: z.string(),
  }),
  setup: z.object({
    worktreePath: z.string(),
    branch: z.string(),
    specTitle: z.string(),
    specDescription: z.string(),
    acceptanceCriteria: z.string(),
    trackerState: z.string(),
    epicChildMismatch: z.boolean().describe("True if this ticket is an epic child but base is the trunk — block before spending agents."),
    suggestedBase: z.string().describe("The integration branch this epic child should stack on (when epicChildMismatch)."),
  }),
  specArchitect: z.object({ notes: z.string(), blockers: z.array(z.string()) }),
  specQa: z.object({ testPlan: z.string(), blockers: z.array(z.string()) }),
  specApproval: z.object({ approved: z.boolean() }),
  red: z.object({ redVerified: z.boolean(), testOutput: z.string(), summary: z.string() }),
  green: z.object({ green: z.boolean(), testOutput: z.string(), summary: z.string() }),
  refactor: z.object({ changed: z.boolean(), summary: z.string() }),
  reviewFind: z.object({
    p0p1: z.number().int(),
    p2: z.number().int(),
    p3: z.number().int(),
    clean: z.boolean(),
    findings: z.string(),
  }),
  reviewFix: z.object({ summary: z.string() }),
  pr: z.object({ number: z.number().int(), url: z.string(), title: z.string() }),
  blocked: z.object({ stage: z.string(), reason: z.string(), detail: z.string() }),
  reviewBot: z.object({ outcome: z.string(), detail: z.string() }),
});

const SKILL = ".claude/skills/rig-task/SKILL.md";
const cd = (wt: string) => `Work in the worktree \`${wt}\` — start every shell command with \`cd "${wt}" &&\`.`;

export default smithers((ctx) => {
  const { phase } = ctx.input;
  const runStart = phase === "start" || phase === "both";
  const runFinish = phase === "finish" || phase === "both";

  // Gate values, read from prior node outputs (undefined until they run).
  const pre = ctx.outputMaybe(outputs.preflight, { nodeId: "preflight" });
  const setup = ctx.outputMaybe(outputs.setup, { nodeId: "setup" });
  const arch = ctx.outputMaybe(outputs.specArchitect, { nodeId: "spec-architect" });
  const qa = ctx.outputMaybe(outputs.specQa, { nodeId: "spec-qa" });
  const specBlockers = [...(arch?.blockers ?? []), ...(qa?.blockers ?? [])];
  // The spec-review approval only gates when specGate is on. /rig-epic passes
  // specGate:false (it front-loads one epic-level spec approval) so a child never
  // pauses mid-run — a paused Subflow child fails the parent epic.
  const specGate = ctx.input.specGate !== false;
  const specHasBlockers = specBlockers.length > 0 && specGate;

  const greenRow = ctx.latest(outputs.green, "green-step");
  const green = greenRow?.green === true;

  const reviewRow = ctx.latest(outputs.reviewFind, "review-find");
  const reviewHasP0P1 = (reviewRow?.p0p1 ?? 0) > 0;
  const reviewClean = reviewRow?.clean === true;
  const maxRounds = pre?.maxRounds ?? 5;

  // Auto-merge mode: after self-review is clean, SQUASH-merge the PR via
  // `gh pr merge --squash --auto` (required checks gate it; merges directly if
  // there are none). Always squash — never rebase. autoMerge=false → never merges.
  const autoMerge = ctx.input.autoMerge === true;
  // Early base guard: this ticket is an epic child but base is the trunk.
  const specMismatch = setup?.epicChildMismatch === true;

  const openPr = ctx.outputMaybe(outputs.pr, { nodeId: "open-pr" });
  const blockedReview = ctx.outputMaybe(outputs.blocked, { nodeId: "blocked-review" });
  const blockedGreen = ctx.outputMaybe(outputs.blocked, { nodeId: "blocked-green" });
  const blockedBase = ctx.outputMaybe(outputs.blocked, { nodeId: "blocked-base" });
  const startTerminal = !runStart || Boolean(openPr || blockedReview || blockedGreen || blockedBase);

  const prNumber = openPr?.number ?? ctx.input.prNumber;
  const canFinish = runFinish && prNumber != null;
  const reviewBotRow = ctx.outputMaybe(outputs.reviewBot, { nodeId: "review-bot" });
  const finishTerminal = !canFinish || Boolean(reviewBotRow);

  const showResult = startTerminal && finishTerminal;

  return (
    <Workflow name="rig-task">
      <UI entry="../ui/rig-task.tsx" title="rig-task — implement one unit end-to-end" />

      {/* ── Step 0: resolve the unit + config from .rig/config.json ── */}
      <Task id="preflight" output={outputs.preflight} retries={0}>
        {async () => {
          const def = {
            baseRef: "origin/main",
            testCommand: "npm test",
            trackerProvider: "none",
            ticketPrefix: "",
            reviewBot: "none",
            maxRounds: 5,
            defaultBranch: "main",
          };
          let cfg: any = {};
          try {
            cfg = JSON.parse(readFileSync(resolve(process.cwd(), ".rig/config.json"), "utf8"));
          } catch {
            /* unconfigured fallback — tracker none, npm test, origin/main */
          }
          const ticketPrefix = cfg?.tracker?.ticketPrefix ?? def.ticketPrefix;
          const provider = cfg?.tracker?.provider ?? def.trackerProvider;
          const target = ctx.input.target.trim();
          const looksLikeTicket = ticketPrefix && new RegExp(`^${ticketPrefix}\\d+$`, "i").test(target);
          const isAdHoc = provider === "none" || (target !== "" && !looksLikeTicket);
          const baseRef = ctx.input.base.trim() || cfg?.vcs?.baseRef || def.baseRef;
          const unit = target || "(infer from branch)";
          return {
            unit,
            isAdHoc,
            baseRef,
            testCommand: cfg?.test?.command ?? def.testCommand,
            trackerProvider: provider,
            ticketPrefix,
            reviewBot: cfg?.review?.bot ?? def.reviewBot,
            maxRounds: cfg?.review?.maxRounds ?? def.maxRounds,
            defaultBranch: cfg?.vcs?.defaultBranch ?? def.defaultBranch,
            summary: `rig-task ${ctx.input.phase}: ${isAdHoc ? `ad-hoc "${unit}"` : unit} → base ${baseRef}, tests \`${cfg?.test?.command ?? def.testCommand}\`, bot ${cfg?.review?.bot ?? def.reviewBot}`,
          };
        }}
      </Task>

      {/* ── START phase: steps 1-5 ── */}
      {runStart ? (
        <Sequence>
          {/* Step 1 — load spec + set up an isolated worktree */}
          <Task id="setup" agent={ROLE.coord} output={outputs.setup} deps={{ preflight: outputs.preflight }}>
            {(d) => {
              const p = d["preflight"];
              return `You are executing Step 1 of the /rig-task skill. Read ${SKILL} (Step 1) and \`.rig/config.json\` first, then:

0. BASE GUARD — do this BEFORE creating any worktree. Determine whether this ticket is an epic CHILD: its tracker parent is an epic, or an integration branch \`<parent-slug>-*\` for its parent already exists on origin (\`git ls-remote --heads origin\`). ${ctx.input.base ? `A stacked base (\`${ctx.input.base}\`) was provided, so a child is fine — set epicChildMismatch=false.` : "NO stacked base was provided (base is the trunk)."} If it IS an epic child AND no stacked base was provided, STOP immediately: set epicChildMismatch=true, suggestedBase=<the integration branch it should stack on>, do NOT create a worktree, leave the spec fields empty, and return. Otherwise set epicChildMismatch=false and suggestedBase="".

1. Load the spec for: ${p.isAdHoc ? `the ad-hoc task "${ctx.input.target}"` : `ticket ${ctx.input.target || "(infer from the current branch)"}`}.
   - Tracker "${p.trackerProvider}": fetch the issue (Linear MCP get_issue / \`gh issue view\`) and set it to "In Progress" now (idempotent; do this even under githubIntegration). Ad-hoc: the description IS the spec — if it's a one-liner, expand acceptance criteria.
2. Set up an isolated checkout via the /rig-worktree skill (do NOT inline \`git worktree add\`). Branch from \`${p.baseRef}\`${ctx.input.base ? " (a STACKED base — target the PR at it, not the trunk)" : ""}. Use the tracker's suggested gitBranchName verbatim when present, else vcs.branchConvention. Name the session "FEAT:"/"CHORE:" with --skip-if-prefix "EPIC:".

CALLER DIRECTION — treat as authoritative spec resolution and **fold it into the specDescription AND acceptanceCriteria you return** (downstream RED/GREEN read those), applying only the parts relevant to THIS unit:
${ctx.input.specNotes?.trim() ? ctx.input.specNotes : "(none)"}

Restate the acceptance criteria (with the direction folded in) back to yourself before finishing. Return the absolute worktree path, the branch name, the spec title/description, the acceptance criteria (as text), the tracker state you set, epicChildMismatch, and suggestedBase.`;
            }}
          </Task>

          {/* Base guard: epic child on the trunk — stop before spending any review/TDD agents. */}
          {setup && specMismatch ? (
            <Task id="blocked-base" output={outputs.blocked} deps={{ setup: outputs.setup }} retries={0}>
              {(d) => ({
                stage: "base",
                reason: "Epic child launched against the trunk — it must stack on the integration branch",
                detail: `Re-run with base=${d["setup"].suggestedBase || "<integration-branch>"} (or drive it via rig-epic). No worktree created; no review/TDD agents spent.`,
              })}
            </Task>
          ) : null}

          {/* Everything past setup runs only when the base is right. */}
          {setup && !specMismatch ? (
          <Sequence>
          {/* Step 2 — spec review: architect + qa in parallel */}
          <Parallel id="spec-review">
            <Task id="spec-architect" agent={ROLE.architect} output={outputs.specArchitect} deps={{ setup: outputs.setup }}>
              {(d) => {
                const s = d["setup"];
                return `You are the ARCHITECT reviewing a spec for implementability (Step 2 of ${SKILL}). ${cd(s.worktreePath)}

Spec:
${s.specTitle}

${s.specDescription}

Acceptance criteria:
${s.acceptanceCriteria}

Identify ambiguities, missing acceptance criteria, the files that must change, and a suggested implementation order. Return your notes, and a \`blockers\` array listing ONLY things that must be resolved BEFORE coding can start (empty if none).`;
              }}
            </Task>
            <Task id="spec-qa" agent={ROLE.qa} output={outputs.specQa} deps={{ setup: outputs.setup }}>
              {(d) => {
                const s = d["setup"];
                return `You are QA reviewing a spec from a testing perspective (Step 2 of ${SKILL}). ${cd(s.worktreePath)}

Spec:
${s.specTitle}

${s.specDescription}

Acceptance criteria:
${s.acceptanceCriteria}

What test cases are needed? Are the acceptance criteria testable? What edge cases matter? Return a \`testPlan\`, and a \`blockers\` array of ONLY criteria that are untestable/contradictory and must be fixed before coding (empty if none).`;
              }}
            </Task>
          </Parallel>

          {/* Spec-review gate: pause for a human only when a blocker was flagged. */}
          {specHasBlockers ? (
            <Approval
              id="approve-spec"
              output={outputs.specApproval}
              onDeny="fail"
              request={{
                title: "Spec review flagged blockers — proceed?",
                summary: `Resolve/clarify these before coding, then approve to continue (deny halts the run):\n\n- ${specBlockers.join("\n- ")}`,
              }}
            />
          ) : null}

          {/* Step 3 — RED: failing tests first */}
          <Task
            id="red-step"
            agent={ROLE.qa}
            output={outputs.red}
            deps={{ setup: outputs.setup, "spec-architect": outputs.specArchitect, "spec-qa": outputs.specQa }}
          >
            {(d) => {
              const s = d["setup"];
              return `You are executing Step 3 (RED) of ${SKILL}. ${cd(s.worktreePath)}

Write tests for this unit BEFORE any implementation. Cover every acceptance criterion plus the edge cases the architect flagged. Do NOT stub or comment out — the tests must compile and FAIL for the right reason (missing implementation), not a syntax error. Match the project's test framework and colocation conventions.

Spec:
${s.specTitle}
${s.specDescription}

Acceptance criteria:
${s.acceptanceCriteria}

Architect notes:
${d["spec-architect"].notes}

QA test plan:
${d["spec-qa"].testPlan}

Run \`${(ctx.outputMaybe(outputs.preflight, { nodeId: "preflight" })?.testCommand) ?? "the test command"}\` from the worktree. VERIFY RED: each new test must fail with a message reflecting the missing behavior. A new test that passes immediately was pinning existing behavior — rewrite it. Return redVerified=true only when the suite fails for the right reason, plus the test output and a short summary.`;
            }}
          </Task>

          {/* Step 4 — GREEN: minimum implementation, up to 3 iterations */}
          <Loop id="green-loop" until={green} maxIterations={3} onMaxReached="return-last">
            <Task id="green-step" agent={ROLE.coder} output={outputs.green} deps={{ setup: outputs.setup, "red-step": outputs.red }}>
              {(d) => {
                const s = d["setup"];
                const prev = ctx.latest(outputs.green, "green-step");
                return `You are executing Step 4 (GREEN) of ${SKILL}. ${cd(s.worktreePath)}

Make the failing tests pass with the MINIMUM change — no features not required by a test. Explore the affected files first and prefer EXTENDING or REUSING existing code over a parallel implementation.

Spec:
${s.specTitle}
${s.specDescription}

Failing tests (from RED):
${d["red-step"].testOutput}
${prev ? `\nPrevious GREEN attempt still failing with:\n${prev.testOutput}\n(fix these remaining failures)` : ""}

Re-run the full test suite from the worktree. If implementing exposes a missing edge case, add that test first rather than piling untested behavior in. Return green=true only when the whole suite passes, plus the test output and a summary of what you changed.`;
              }}
            </Task>
          </Loop>

          <Branch
            if={green}
            then={
              <Sequence>
                {/* Step 4.25 — REFACTOR (only while green) */}
                <Task id="refactor-step" agent={ROLE.coder} output={outputs.refactor} deps={{ setup: outputs.setup }}>
                  {(d) => {
                    const s = d["setup"];
                    return `You are executing Step 4.25 (REFACTOR) of ${SKILL}. ${cd(s.worktreePath)}

The implementation is GREEN. If — and only if — there is obvious duplication, awkward naming, or a helper that wants extracting, make that cleanup with NO new behavior, then re-run the full suite to confirm it stays green. If the code is already clean, change nothing. Return changed (true/false) and a one-line summary.`;
                  }}
                </Task>

                {/* Step 4.5 — pre-PR self-review gate (find -> fix -> re-find) */}
                <Loop id="review-loop" until={reviewClean} maxIterations={maxRounds} onMaxReached="return-last">
                  <Sequence>
                    <Task id="review-find" agent={ROLE.reviewer} output={outputs.reviewFind} deps={{ setup: outputs.setup, preflight: outputs.preflight }}>
                      {(d) => {
                        const s = d["setup"];
                        return `You are executing Step 4.5 (pre-PR self-review) of ${SKILL} — the FIND half. ${cd(s.worktreePath)}

Run the /rig-review skill for this unit: walk \`${d["preflight"] ? ".claude/REVIEWER.md" : "the review patterns file"}\` against \`git diff ${d["preflight"].baseRef}...HEAD\` and return a triaged P0-P3 list. Count findings by severity: p0p1 (must-fix before merge), p2, p3. Set clean=true only when there are zero P0/P1. Return the findings text too.`;
                      }}
                    </Task>
                    <Branch
                      if={reviewHasP0P1}
                      then={
                        <Task id="review-fix" agent={ROLE.coder} output={outputs.reviewFix} deps={{ setup: outputs.setup, "review-find": outputs.reviewFind }}>
                          {(d) => {
                            const s = d["setup"];
                            return `You are executing Step 4.5 of ${SKILL} — the FIX half (/rig-review fix, local). ${cd(s.worktreePath)}

Fix every P0/P1 finding below, keeping the test suite green. Do NOT touch P2/P3 (they ship as follow-ups).

Findings:
${d["review-find"].findings}

Return a short summary of what you changed. The loop will re-run the review to confirm convergence.`;
                          }}
                        </Task>
                      }
                      else={null}
                    />
                  </Sequence>
                </Loop>

                {/* Step 5 — push + open the PR, only when the self-review is clean */}
                <Branch
                  if={reviewClean}
                  then={
                    <Task id="open-pr" agent={ROLE.coder} output={outputs.pr} deps={{ setup: outputs.setup, preflight: outputs.preflight }}>
                      {(d) => {
                        const s = d["setup"];
                        const p = d["preflight"];
                        return `You are executing Step 5 of ${SKILL}. ${cd(s.worktreePath)}

1. Commit all changes with a message referencing the unit.
2. Push the branch.
3. Open a PR with \`gh pr create\` targeting \`${ctx.input.base || p.defaultBranch}\`:
   - Title carries the ticket id where a tracker is used, e.g. \`feat(${ctx.input.target || "SCOPE"}): …\`.
   - Body: a summary; the tracker link (\`Fixes <id>\` for Linear / \`Closes #<n>\` for GitHub); a test plan; and an \`## Architecture\` section stating any new abstraction/package/dependency/migration or "No architectural change." and WHY existing code wasn't reused.
4. TRACKER LINK + TRANSITION (adaptive — works with OR without a live Linear↔GitHub integration; do NOT trust the githubIntegration config flag, check reality):
   - Ensure the PR is linked to the issue: \`get_issue\`; if no attachment already references this PR URL (the integration may have added one), \`create_attachment\` with the PR URL.
   - Ensure the issue is In Review: \`get_issue\`; if it is NOT already In Review or further along (Done), \`save_issue state="In Review"\`. If the integration already advanced it, leave it — never clobber a further-along state.
${autoMerge
  ? `5. AUTO-MERGE (enabled), self-review is clean: land this PR with **squash** (\`gh pr merge <N> --squash --delete-branch\`, targeting \`${ctx.input.base || p.defaultBranch}\`). If any required check is pending, arm it CI-gated instead: add \`--auto\`. If there are NO required checks (auto-merge can't be armed / the PR is already mergeable), merge directly with the same command minus \`--auto\`. (If \`vcs.protectedBranchMergeQueue\` is true, use \`--auto\` with NO method flag — the queue decides.) Always squash; never rebase. Don't merge manually beyond this.`
  : `5. Do NOT \`gh pr merge\` — this run does not auto-merge; the PR waits for a human.`}

Return the PR number, URL, and title.`;
                      }}
                    </Task>
                  }
                  else={
                    <Task id="blocked-review" output={outputs.blocked} deps={{ "review-find": outputs.reviewFind }} retries={0}>
                      {(d) => ({
                        stage: "self-review",
                        reason: "P0/P1 findings unresolved after the max review rounds",
                        detail: d["review-find"].findings,
                      })}
                    </Task>
                  }
                />
              </Sequence>
            }
            else={
              <Task id="blocked-green" output={outputs.blocked} deps={{ "red-step": outputs.red }} retries={0}>
                {() => {
                  const g = ctx.latest(outputs.green, "green-step");
                  return {
                    stage: "green",
                    reason: "Tests still failing after 3 GREEN iterations — spec likely wrong or an unstated constraint",
                    detail: g?.testOutput ?? "(no test output captured)",
                  };
                }}
              </Task>
            }
          />
          </Sequence>
          ) : null}
        </Sequence>
      ) : null}

      {/* ── FINISH phase: step 6 (review-bot loop) ── */}
      {canFinish ? (
        <Task id="review-bot" agent={ROLE.coord} output={outputs.reviewBot} deps={{ preflight: outputs.preflight }}>
          {(d) => {
            const p = d["preflight"];
            const wt = setup?.worktreePath;
            return `You are executing Step 6 (review-bot loop) of ${SKILL} for PR #${prNumber}. ${wt ? cd(wt) : "First re-establish context: resolve the open PR's worktree from PR #" + prNumber + " / the current branch and cd into it."}

Review bot: \`${p.reviewBot}\`. ${ctx.input.local ? "The --local flag is set: force the local /rig-review fix loop." : ""}
- reviewBot "none" → nothing to drive; the Step 4.5 local gate was the whole review. outcome="clean".
- A cloud auto-fix workflow is enabled and --local was NOT passed → WATCH only (do not fix or push). Poll the PR (~60s, up to ~30min) until the bot's review reaches a terminal state; report it.
- Otherwise → DRIVE via the /rig-review fix loop: poll + classify the bot's review, fix via a coding agent, commit, push, re-trigger (\`${p.reviewBot === "bugbot" ? "bugbot run" : "the configured retrigger"}\`), up to ${p.maxRounds} rounds.

Return outcome as exactly one of: "clean" (no actionable issues — merge gates take over), "actionable" (feedback remains after the last round), or "timeout" (bot didn't respond). Do NOT merge. Include a short detail string.`;
          }}
        </Task>
      ) : null}

      {/* ── Step 7 — hand back (report only; never merges) ── */}
      {showResult ? (
        <Task id="result" output={outputs.result} retries={0}>
          {() => {
            const bot = ctx.outputMaybe(outputs.reviewBot, { nodeId: "review-bot" });
            const g = ctx.latest(outputs.green, "green-step");
            const rev = ctx.latest(outputs.reviewFind, "review-find");
            const blk = blockedBase ?? blockedGreen ?? blockedReview;
            let outcome = "pr-open";
            if (blk) outcome = "blocked";
            else if (bot) outcome = bot.outcome;
            const testsGreen = g?.green === true;
            const reviewState = rev ? `${rev.p0p1} P0/P1 + ${rev.p2} P2 + ${rev.p3} P3` : "n/a";
            const unit = pre?.unit ?? ctx.input.target;
            const prUrl = openPr?.url ?? "";
            const mergeNote = autoMerge ? "squash-merge enabled (CI-gated if checks exist, else direct)" : "not merged (waits for a human)";
            const summary = blk
              ? `BLOCKED at ${blk.stage}: ${blk.reason}.${blk.stage === "base" ? "" : " No PR opened."}`
              : bot
                ? `PR ${prUrl} — review-bot outcome: ${bot.outcome}. ${bot.outcome === "clean" ? `Merge gate: ${mergeNote}.` : "Left for a human."}`
                : `PR opened: ${prUrl}. tests: ${testsGreen ? "green" : "red"}, review: ${reviewState}. ${mergeNote}.`;
            return { outcome, unit, prUrl, testsGreen, reviewState, summary };
          }}
        </Task>
      ) : null}
    </Workflow>
  );
}, { output: outputs.result });
