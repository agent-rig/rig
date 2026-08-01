// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-loop — autonomous build loop (SKETCH)
// smithers-description: Drains a ticket backlog one unit at a time — advisor-picks the next ready ticket, builds it via rig-task, verifies with evidence-based backpressure, lands it, and carries distilled state across generations until the backlog is dry or the budget is spent. First-pass sketch.
// smithers-tags: rig, autonomous, loop, sketch
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Aspects } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { TaskFlow, taskSchemas, taskBag, taskResultSchema } from "./flows/task-flow";
import { EpicFlow, epicSchemas, epicBag } from "./flows/epic-flow";

/**
 * rig-loop — an autonomous build loop grounded in Smithers context-engineering:
 *   pick → build → verify → land → repeat, until the backlog is dry or the budget's spent.
 *
 * Theses it embodies (from smithers.sh/guides/context-engineering):
 *  - "An agent is a loop that manufactures a better context window." Each turn resolves
 *    the next unit and hands the child a clean, sufficient spec.
 *  - Keep the ORCHESTRATOR lean (<100k): nodes exchange TYPED SUMMARIES, never raw diffs;
 *    the durable state lives in the TRACKER, not in orchestrator memory.
 *  - Backpressure is the gate: a unit suite + a REQUIRED e2e decide "done", not vibes.
 *  - Split decision from act: verify (reversible) is separate from land (irreversible), gated last.
 *  - Evidence-based red vs infra: a nonzero exit with no failure evidence is infra → retry, not a defect.
 *  - Longevity: the Loop's own `continueAsNewEvery` /clears and carries state across generations.
 *
 * Hardening path (native components that replace the hand-rolled bits, once the core proves out):
 *  - <MergeQueue> — serialize the irreversible LAND across concurrent loop iterations (one merge at a time).
 *  - <Saga>/<SagaStep> — compensating rollback if a land half-completes.
 *  - <EscalationChain> — advisor decides autonomously, but escalates to a human on genuine uncertainty
 *    (resolves "must I always drive this myself?" — hands off only the hard calls).
 *  - <DriftDetector> — guards the long-run "goal has blurred 50 turns in" failure mode.
 *  - <ScanFixVerify> — a ready-made build→verify→fix inner loop, if we want retries inside a unit.
 */

// Both branches compose their flow INLINE (one run, native deps) — no childRun Subflow anywhere.
const SKILL = ".claude/skills/rig-task/SKILL.md";

const SMART = providers.claudeOpus; // judgment: pick + verify
const CHEAP = providers.claudeSonnet; // mechanical: land + report

const inputSchema = z.object({
  scope: z.string().default("").describe("Which tickets are in play — a milestone/label/query the picker drains (e.g. 'Polish'). Empty = all ready backlog."),
  maxUnits: z.number().int().default(8).describe("Safety ceiling on units this run; the loop also stops when the backlog is dry or the token budget is spent."),
  advisor: z.boolean().default(true).describe("Autonomous: gate decisions are made by an advisor, no human waits. false → park for a human."),
  built: z.array(z.string()).default([]).describe("Optional seed of already-landed tickets (for resumes); the picker's real source of truth is the tracker's Done state."),
});
const resultSchema = z.object({ done: z.boolean(), built: z.array(z.string()), note: z.string() });

// Lean, TYPED node interfaces — this is all the orchestrator ever sees (never raw diffs/logs).
const { Workflow, Sequence, Parallel, Task, Loop, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  result: resultSchema,
  // Inline-composition tables (no collisions): canonical TaskFlow (task branch),
  // namespaced child_ TaskFlow (the epic branch's children) + epic_ EpicFlow (epic branch).
  ...taskSchemas(),
  ...taskSchemas("child"),
  ...epicSchemas("epic"),
  pick: z.object({ ticketId: z.string(), ready: z.boolean(), shape: z.enum(["epic", "task"]).default("task"), rationale: z.string() }), // ticketId "" = backlog dry; shape routes EpicFlow vs TaskFlow
  taskUnit: taskResultSchema, // where the inline TaskFlow terminal lands (task branch)
  probe: z.object({ lens: z.string(), riskFound: z.boolean(), evidence: z.string() }), // DeriskLoop-pattern risk probes
  verify: z.object({ green: z.boolean(), kind: z.string(), evidence: z.string() }), // kind: unit | e2e | risk | infra
  land: z.object({ ticketId: z.string(), merged: z.boolean(), detail: z.string() }),
});

export default smithers((ctx) => {
  const advisor = ctx.input.advisor !== false;
  const seed = (ctx.input.built ?? []).join(", ") || "(none)";

  const pick = ctx.latest(outputs.pick, "pick");
  const backlogDry = Boolean(pick && (pick.ready === false || (pick.ticketId ?? "") === ""));
  const verify = ctx.latest(outputs.verify, "verify");
  const verifyGreen = verify?.green === true;

  // Bags for the inline EpicFlow (epic branch): epic tables namespaced "epic_", its
  // children's TaskFlow tables namespaced "child_"; the child terminals land in epic_childRun.
  const epicTables = epicBag(outputs, "epic");
  const childTablesForEpic = taskBag(outputs, epicTables.childRun, "child");

  return (
    <Workflow name="rig-loop">
      {/* Keep the ORCHESTRATOR lean so it can run all day: a hard token ceiling on the whole run;
          children summarize into it rather than dumping diffs/logs. */}
      <Aspects tokenBudget={{ max: 400_000, onExceeded: "skip-remaining" }}>
        {/* The loop. Stop when the backlog is dry (until), or the safety ceiling (maxIterations);
            /clear and carry loop state every 3 units so context never bloats across a long drain. */}
        <Loop id="loop" until={backlogDry} maxIterations={ctx.input.maxUnits} onMaxReached="return-last" continueAsNewEvery={3}>
          <Sequence>
            {/* 1 · PICK — advisor names the next READY, TOP-LEVEL work item and classifies its SHAPE.
                Top-level only: children of an epic are drained INSIDE rig-epic, never picked here, or
                they'd be built twice. Shape = the rig interleave test: a parent whose children interleave
                (one child's runtime contract depends on another's incomplete state) is an "epic"; a
                standalone leaf is a "task". Source of truth is the TRACKER. */}
            <Task id="pick" agent={SMART} output={outputs.pick}>
              {() => `From scope "${ctx.input.scope || "the backlog"}", pick the single next READY, TOP-LEVEL item to build (top-level = it has no parent epic of its own; skip child tickets — those are handled inside their epic). Ready = all its blockedBy are Done. Classify \`shape\`: "epic" if it's a parent whose children interleave (one child's runtime contract depends on another's incomplete state — the rig epic test), else "task" for a standalone unit. Query the tracker; skip anything already Done or in this seed list: ${seed}. Return {ticketId, ready, shape, rationale}; set ticketId="" and ready=false if nothing is ready (backlog dry).`}
            </Task>

            {/* Build only when there's a ready pick; otherwise `until` (backlogDry) ends the loop next check. */}
            <Branch
              if={pick?.ready === true && (pick?.ticketId ?? "") !== ""}
              then={
                <Branch
                  if={pick?.shape === "epic"}
                  then={
                    /* EPIC — compose EpicFlow INLINE (one run, native deps; no childRun). It front-loads
                       the spec (advisor-gated), stacks each child as an inline TaskFlow, reviews the
                       combined diff, and squashes to the trunk. EpicFlow OWNS its own gate + landing,
                       so the loop doesn't re-verify/land — self-contained through trunk (merge:true). */
                    <EpicFlow
                      input={{ phase: "full", feature: "", parent: pick?.ticketId ?? "", merge: true, advisor }}
                      ctx={ctx}
                      tables={epicTables}
                      childTables={childTablesForEpic}
                    />
                  }
                  else={
                    /* TASK — the loop owns the gate: build → e2e verify → land. */
                    <Sequence>
                      {/* 2 · BUILD — TaskFlow composed INLINE (one run, native deps, full time-travel;
                          no childRun Subflow). idPrefix "task-" namespaces its nodes; its terminal
                          summary lands in outputs.taskUnit. phase "both" runs the FULL rig-task incl. the
                          review-bot (Bugbot) loop, so the unit is bot-clean BEFORE the loop verifies+lands.
                          spec pre-cleared so it never pauses. */}
                      <TaskFlow
                        input={{ target: pick?.ticketId ?? "", phase: "both", base: "", local: false, autoMerge: false, specGate: false, specNotes: "" }}
                        ctx={ctx}
                        tables={taskBag(outputs, outputs.taskUnit)}
                        idPrefix="task-"
                      />

                      {/* 3 · VERIFY — a DeriskLoop-PATTERN risk-probe gate (the <DeriskLoop> component is
                          welded to the delegation framework, so we adapt its shape). Two independent,
                          adversarial probes run in parallel, then a verdict folds them in with the unit+e2e
                          check. Ordering is by <Sequence>; the verdict reads the probes via suffix-lenient
                          ctx.latest (NOT a hard dep — those deadlock on looped/sibling nodes, per the fix). */}
                      <Sequence>
                        <Parallel id="derisk-probes">
                          <Task id="probe-regression" agent={SMART} output={outputs.probe} deps={{ "task-result": outputs.taskUnit }}>
                            {(d) => `Adversarially probe ${pick?.ticketId} (PR ${d["task-result"].prUrl || "n/a"}) for REGRESSIONS: inspect/exercise the existing behaviors the change touches and try to find one it silently breaks. Return {lens:"regression", riskFound, evidence}. riskFound=true ONLY with concrete evidence of a broken behavior (a failing case, a changed output that shouldn't have); default false.`}
                          </Task>
                          <Task id="probe-contract" agent={SMART} output={outputs.probe} deps={{ "task-result": outputs.taskUnit }}>
                            {(d) => `Adversarially probe ${pick?.ticketId} (PR ${d["task-result"].prUrl || "n/a"}) for CONTRACT/CALLER breaks: does it change a wire/type/API contract, or leave a caller, schema, or downstream consumer unupdated? Return {lens:"contract", riskFound, evidence}. riskFound=true ONLY with a concrete unupdated caller / broken contract; default false.`}
                          </Task>
                        </Parallel>
                        <Task id="verify" agent={SMART} output={outputs.verify} deps={{ "task-result": outputs.taskUnit }}>
                          {(d) => {
                            const reg = ctx.outputMaybe(outputs.probe, { nodeId: "probe-regression" });
                            const con = ctx.outputMaybe(outputs.probe, { nodeId: "probe-contract" });
                            return `Final verify for ${pick?.ticketId} (PR ${d["task-result"].prUrl || "n/a"}), in its worktree (see ${SKILL}). Run the unit suite AND drive the real end-to-end path. Also weigh the two risk probes:
- regression: riskFound=${reg?.riskFound ?? "?"} — ${reg?.evidence ?? "(pending)"}
- contract: riskFound=${con?.riskFound ?? "?"} — ${con?.evidence ?? "(pending)"}
Set green=true ONLY if the unit suite AND e2e pass AND neither probe confirmed a real risk. Else set \`kind\`: "unit"/"e2e" for a genuine test failure (real \`error TS…\` / failed-test evidence), "risk" if a probe confirmed a real regression/contract break, or "infra" for a nonzero exit with NO such evidence (flaky env) — infra is NOT a defect. Put the deciding evidence in \`evidence\`.`;
                          }}
                        </Task>
                      </Sequence>

                      {/* 4 · LAND — the irreversible act, gated LAST on a green verify. Decision split from act. */}
                      <Branch
                        if={verifyGreen}
                        then={
                          <Task id="land" agent={CHEAP} output={outputs.land} deps={{ "task-result": outputs.taskUnit }}>
                            {(d) => `Land ${pick?.ticketId}: squash-merge the PR (${d["task-result"].prUrl}) to the trunk once its required checks pass (CI is the gate; merge directly if there are none), then mark the ticket Done (adaptive — defer if a live integration already closed it). Return {ticketId, merged, detail}.`}
                          </Task>
                        }
                        else={
                          <Task id="park" output={outputs.land} deps={{ verify: outputs.verify }} retries={0}>
                            {(d) => ({ ticketId: pick?.ticketId ?? "", merged: false, detail: `not landed — ${d["verify"].kind}: ${d["verify"].evidence.slice(0, 300)}` })}
                          </Task>
                        }
                      />
                    </Sequence>
                  }
                />
              }
              else={null}
            />
          </Sequence>
        </Loop>
      </Aspects>

      {/* Terminal report — read the tracker (durable source of truth), don't reconstruct from memory. */}
      <Task id="result" agent={CHEAP} output={outputs.result} deps={{ pick: outputs.pick }}>
        {() => `The loop has stopped for scope "${ctx.input.scope || "the backlog"}". Report {done, built, note}: done=true if the backlog is dry (no ready tickets remain), false if it stopped on the ceiling/budget. \`built\` = the tickets this run moved to Done (check the tracker + merged PRs). Keep \`note\` to one line.`}
      </Task>
    </Workflow>
  );
}, { output: outputs.result });
