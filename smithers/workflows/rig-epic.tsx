// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-epic — integration-branch workflow
// smithers-description: Canonicalizes the /rig-epic skill as a durable graph — decompose a feature into parent + children, stack each child PR (inline TaskFlow) on a shared integration branch, review the combined diff across three lenses, then squash to the trunk. Never auto-merges the trunk without opt-in. Thin wrapper over the composable EpicFlow fragment.
// smithers-tags: rig, epic, integration-branch, stacked-prs
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI } from "smithers-orchestrator";
import { EpicFlow, epicSchemas, epicBag, epicInputSchema, epicResultSchema } from "./flows/epic-flow";
import { taskSchemas, taskBag } from "./flows/task-flow";

/**
 * Standalone rig-epic = the EpicFlow fragment under its own <Workflow>. The graph
 * lives in flows/epic-flow.tsx so rig-crank can compose it INLINE (one run, native
 * deps, no childRun). Register EpicFlow's own tables + the child TaskFlow tables
 * (namespaced "child_" — no collision with epic's own reviewFix/etc.).
 */
const { Workflow, smithers, outputs } = createSmithers({
  input: epicInputSchema,
  output: epicResultSchema,
  ...epicSchemas(),
  ...taskSchemas("child"),
});

export default smithers(
  (ctx) => (
    <Workflow name="rig-epic">
      <UI entry="../ui/rig-epic.tsx" title="rig-epic — integration-branch workflow" />
      <EpicFlow
        input={ctx.input}
        ctx={ctx}
        tables={epicBag(outputs)}
        childTables={taskBag(outputs, outputs.childRun, "child")}
      />
    </Workflow>
  ),
  { output: outputs.epicResult },
);
