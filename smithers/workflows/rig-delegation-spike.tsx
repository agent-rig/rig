// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-delegation-spike — DelegationChain evaluation
// smithers-description: SPIKE. Points Smithers' off-the-shelf DelegationChain (recursive tiered delegation: refine → decompose → derisk → execute → score) at a single ask, to evaluate whether the suite could replace hand-built rig-crank/rig-epic orchestration. Not wired to the tracker or the integration-branch model — that's the open question.
// smithers-tags: rig, delegation, spike, evaluation
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, DelegationChain, delegationSchemas } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

/**
 * SPIKE — is DelegationChain a shortcut to the autonomous build loop, or a mismatch?
 *
 * DelegationChain is the composite behind the `delegation-chain` workflow: a recursive,
 * self-decomposing delegation engine. From ONE prompt it runs seven reactive phases —
 * goal refinement, recursive decomposition (fan-out until the frontier is all leaves),
 * derisk probes, dependency-ordered leaf execution with gates + budgets, and scoring —
 * replanning affected subtrees as rows land, without restarting.
 *
 * What we get for free (things we hand-build in rig-crank/rig-epic):
 *  - recursive decomposition (rig-epic's plan) + level-by-level fan-out
 *  - per-node backpressure, budgets (maxUsd/maxMinutes → Aspects), scoring
 *  - tiered model routing (strongest-first with fallback) — our ROLE map, generalized
 *  - live edits + derisk replanning mid-run
 *
 * What it does NOT know (the rig-specific substance — the open question):
 *  - the TRACKER: Linear tickets, blockedBy, adaptive Done transitions
 *  - the integration-branch / stacked-PR model and squash-to-trunk
 *  - the rig ROLES as a *process* (architect → TDD coder → qa → reviewer), not just tiers
 *  - TDD (RED→GREEN→REFACTOR), the pre-PR self-review, the review-bot loop
 *  - worktree isolation per unit (though <Worktree>/<Sandbox> compose in)
 *
 * Tiers are LABELS, not model ids; missing tiers fall back to the nearest in tierOrder.
 * Map them onto our providers so the spike uses our real agents.
 */

const inputSchema = z.object({
  prompt: z.string().default("").describe("The ask to hand the delegation engine (e.g. a Polish ticket's spec pasted in, or 'Implement CEX-551: true fractional matching in the mock-venue engine')."),
});

const { Workflow, smithers, outputs } = createSmithers({ input: inputSchema, ...delegationSchemas });

export default smithers((ctx) => (
  <Workflow name="rig-delegation-spike">
    <DelegationChain
      prompt={ctx.input?.prompt ?? ""}
      agents={{
        fable: providers.claude, // planner/refiner
        opus: providers.claudeOpus, // hardest decomposition + review
        sonnet: providers.claudeSonnet, // execution
        // haiku omitted → falls back to the nearest configured tier
      }}
      outputs={outputs}
      maxDepth={2}
      maxConcurrency={4}
      budget={{ maxMinutes: 30 }}
    />
  </Workflow>
));
