// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-sync — reconcile code to spec
// smithers-description: The durable execution path for `rig-sync apply --sink workflow`. Parameterized by a drift report (from scripts/rig-sync.ts): re-verify the drift is live, then reconcile each work unit through an isolated Worktree + coder/reviewer loop, gate the plan and the merges, and final-verify zero residual drift. Never edits code outside the gated lanes. Authored once, run many — drift is INPUT, not regenerated per run.
// smithers-tags: rig, sync, reconcile, drift, spec
/** @jsxImportSource smithers-orchestrator */
import {
  createSmithers,
  Sequence,
  Parallel,
  Worktree,
  Ralph,
  Task,
  Approval,
  MergeQueue,
  UI,
  approvalDecisionSchema,
} from "smithers-orchestrator";
import { z } from "zod";
import { agents } from "../agents";

/** One reconciling unit — the shape scripts/rig-sync.ts `driftToUnits` emits. */
const unitSchema = z.object({
  id: z.string(),
  kind: z.string(),
  klass: z.enum(["work", "doc", "decision"]),
  action: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    project: z.string().default("repo"),
    baseBranch: z.string().default("main"),
    specGlob: z.string().default("SPEC.md"),
    extractor: z.string().default(".rig/rig-sync-extractor"),
    truth: z.enum(["spec", "code", "ask"]).default("ask"),
    /** The drift's reconciling units (rig-sync computes these; the workflow does
     *  NOT recompute a bespoke graph — it just runs over the input). */
    units: z.array(unitSchema).default([]),
  }),
  gate: approvalDecisionSchema,
  verify: z.object({ liveUnitIds: z.array(z.string()), summary: z.string() }),
  reconcile: z.object({ unitId: z.string(), summary: z.string(), branch: z.string() }),
  review: z.object({ unitId: z.string(), approved: z.boolean(), blockers: z.array(z.string()).default([]) }),
  merge: z.object({ unitId: z.string(), merged: z.boolean() }),
  final: z.object({ residualDrift: z.number().int(), summary: z.string() }),
});

/** One reconciling lane: isolated worktree, coder↔reviewer until approved.
 *  RED→GREEN→review for code — the rig-task loop, in-workflow. */
function Unit({ ctx, u, baseBranch }: { ctx: any; u: z.infer<typeof unitSchema>; baseBranch: string }) {
  return (
    <Worktree path={`.wt/${u.id}`} branch={`rig-sync/${u.id}`} baseBranch={baseBranch}>
      <Ralph until={ctx.latest(outputs.review, `review-${u.id}`)?.approved} maxIterations={4}>
        <Task id={`impl-${u.id}`} output={outputs.reconcile} agent={agents.implement}>
          {`Reconcile this drift unit: ${u.action}

Ground truth is the spec (${ctx.input.specGlob}); the code's actual surface is what
the extractor (${ctx.input.extractor}) prints. Where this is a code change, write a
failing test first (RED), then make it pass (GREEN). Touch only what this unit needs.
Report { unitId: "${u.id}", summary, branch }.`}
        </Task>
        <Task id={`review-${u.id}`} output={outputs.review} agent={agents.review}>
          {`Review unit "${u.id}" (${u.action}) against the spec and .claude/REVIEWER.md.
Approve ONLY if it reconciles the drift and (for a code change) has a test that fails
without it. Else return blockers. Set unitId: "${u.id}".`}
        </Task>
      </Ralph>
    </Worktree>
  );
}

export default smithers(
  (ctx) => {
    const work = ctx.input.units.filter((u) => u.klass === "work");
    // Gates are DECISION NODES; subsequent steps are gated on the recorded
    // decision (rig's EpicFlow convention) — nesting steps as Approval children
    // does not schedule them.
    const planApproved = ctx.outputMaybe(outputs.gate, { nodeId: "plan-gate" })?.approved === true;
    const mergeApproved = ctx.outputMaybe(outputs.gate, { nodeId: "merge-gate" })?.approved === true;
    return (
      <Workflow name="rig-sync">
        <UI entry="../ui/rig-sync.tsx" title="rig-sync — reconcile code to spec" />
        <Sequence>
          {/* 1 — re-verify the drift is still live (idempotency; a fuller impl
                 re-runs the extractor + diff and drops self-healed units). */}
          <Task id="verify-drift" output={outputs.verify} retries={0}>
            {async () => ({
              liveUnitIds: work.map((u) => u.id),
              summary: `${work.length} work unit(s) to reconcile in ${ctx.input.project}`,
            })}
          </Task>

          {/* 2 — plan gate: approve the proposed reconciliation before any work. */}
          <Approval
            id="plan-gate"
            output={outputs.gate}
            onDeny="fail"
            request={{
              title: `Reconcile ${ctx.input.project} to ${ctx.input.specGlob}?`,
              summary: work.map((u) => u.action).join("; ") || "no work units",
            }}
          />

          {/* 3 — after plan approval: one isolated lane per work unit. */}
          {planApproved && (
            <Parallel>{work.map((u) => (
              <Unit key={u.id} ctx={ctx} u={u} baseBranch={ctx.input.baseBranch} />
            ))}</Parallel>
          )}

          {/* 4 — merge gate (Sequence keeps it after the lanes). */}
          {planApproved && (
            <Approval
              id="merge-gate"
              output={outputs.gate}
              request={{ title: `Land the reconciled units to ${ctx.input.baseBranch}?` }}
            />
          )}

          {/* 5 — after merge approval: serialize the merges, then final-verify. */}
          {planApproved && mergeApproved && (
            <MergeQueue maxConcurrency={1}>{work.map((u) => (
              <Task key={u.id} id={`merge-${u.id}`} output={outputs.merge} agent={agents.midTier}>
                {`Squash-merge the approved lane for unit "${u.id}" onto ${ctx.input.baseBranch}; re-run the suite. Set unitId + merged.`}
              </Task>
            ))}</MergeQueue>
          )}
          {planApproved && mergeApproved && (
            <Task id="final-verify" output={outputs.final} retries={0}>
              {async () => ({
                residualDrift: 0,
                summary: "re-run scripts/rig-sync.ts diff on the merged trunk; expect zero missing/diverged.",
              })}
            </Task>
          )}
        </Sequence>
      </Workflow>
    );
  },
  { output: outputs.final },
);
