// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: rig-task — implement one unit end-to-end
// smithers-description: Canonicalizes the /rig-task skill as a durable graph — load spec, spec review, TDD (RED -> GREEN -> REFACTOR), pre-PR self-review gate, open PR, then the review-bot loop. Never auto-merges. Thin wrapper over the composable TaskFlow fragment.
// smithers-tags: rig, implement, tdd, review
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI } from "smithers-orchestrator";
import { TaskFlow, taskSchemas, taskBag, taskInputSchema, taskResultSchema } from "./flows/task-flow";

/**
 * Standalone rig-task = the TaskFlow fragment under its own <Workflow>. The graph
 * lives in flows/task-flow.tsx so rig-loop / EpicFlow can render it INLINE (one run,
 * native deps, full time-travel) instead of a childRun <Subflow>. Registering
 * TASK_TABLES here is what makes `outputs` carry the fragment's tables.
 */
const { Workflow, smithers, outputs } = createSmithers({
  input: taskInputSchema,
  result: taskResultSchema,
  ...taskSchemas(),
});

export default smithers(
  (ctx) => (
    <Workflow name="rig-task">
      <UI entry="../ui/rig-task.tsx" title="rig-task — implement one unit end-to-end" />
      <TaskFlow input={ctx.input} ctx={ctx} tables={taskBag(outputs, outputs.result)} idPrefix="" />
    </Workflow>
  ),
  { output: outputs.result },
);
