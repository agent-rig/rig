/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sequence, Parallel, Task, Branch, Approval, HumanTask, GatherAndSynthesize } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../../agents";
import { TaskFlow } from "./task-flow";

/**
 * EpicFlow — the /rig-epic graph as a COMPOSABLE React fragment (no <Workflow>).
 *
 * Same contract as TaskFlow: `tables` is a bag mapping each epic table name to the
 * composer's OutputTarget (build with `epicBag(outputs, ns?)`, register with
 * `epicSchemas(ns?)`); `childTables` is the task bag its inline child TaskFlows write to
 * (build with `taskBag(outputs, tables.childRun, "child")`). Composed inline by rig-crank
 * or run standalone by the thin rig-epic wrapper — one run, native deps, no childRun.
 *
 * EpicFlow keeps literal node ids (it is composed one epic at a time; a crank Loop
 * iteration-scopes across epics), so it takes no idPrefix — but each child TaskFlow is
 * namespaced by `child-<id>-`.
 */

/**
 * Role -> model, matched to .claude/agents/rig-*.md (architect/reviewer = opus,
 * qa/coder = sonnet). Single Claude model per role, NOT the codex/fable-leading
 * pools in agents.ts. `coord` = orchestration steps with no rig role (git/gh,
 * state file, merge gate) -> conservative sonnet.
 */
const ROLE = {
  architect: providers.claudeOpus,
  reviewer: providers.claudeOpus,
  qa: providers.claudeSonnet,
  coder: providers.claudeSonnet,
  coord: providers.claudeSonnet,
  // `advisor` = the autonomous arch gate: Fable stands in for the human at the
  // front-loaded spec gate so a kicked-off epic runs unattended (see `advisor` input).
  advisor: providers.claude,
} as const;

// Reference the rig-task workflow by file (resolved relative to THIS module, so
// it is cwd-independent). Loaded from the approved root when a child node runs.
// Children run as INLINE TaskFlow fragments (one run, native deps) — no childRun Subflow.

/**
 * Canonical graph of the /rig-epic skill (.claude/skills/rig-epic/SKILL.md).
 *
 *   epic-preflight
 *     plan  -> start                         (phase plan|full: steps `plan` + `start`)
 *     (approve-run gate, full only)
 *     run: for each child in dependency (topological) order —
 *          inline TaskFlow(--base <integration-branch>) -> merge-gate       (phase run|full)
 *     review: [simplify | cross-pr | dead-code] -> consolidate -> approve   (phase review|full)
 *     finish: review gate -> squash PR -> (optional --merge)                (phase finish|full)
 *
 * Each child is the rig-task workflow run against the integration branch, so
 * the two canonicalized skills compose exactly as /rig-epic delegates to
 * /rig-task in prose.
 */

export const childSchema = z.object({
  id: z.string(),
  title: z.string(),
  blockedBy: z.array(z.string()).default([]),
  status: z.string().default("todo"),
});
type Child = z.infer<typeof childSchema>;

export const epicInputSchema = z.object({
  phase: z
    .enum(["plan", "run", "review", "finish", "full"])
    .default("full")
    .describe("full (default) = the whole arc plan→run→review→finish as ONE durable run, pausing only at in-graph approval gates. plan/run/review/finish are partial entry points; finish always runs the review gate first. An existing epic (parent + state, no feature) skips planning and resumes from what's already merged."),
  feature: z.string().default("").describe("The feature to decompose (phase plan/full)."),
  parent: z.string().default("").describe("Parent id or integration branch to resume from (phase run/review/finish). Empty = infer the single active epic."),
  merge: z.boolean().default(false).describe("finish --merge: squash-merge the final PR to the trunk instead of stopping at an open PR."),
  advisor: z
    .boolean()
    .default(false)
    .describe("Autonomous arch gate. When true, the front-loaded spec gate (spec-direction) is decided by a Fable advisor instead of a human: it reads the architect+QA specs, then either proceed=true with synthesized per-child direction, or proceed=false → the epic HALTS with a blocked report (no human ever waits). Lets parallel epics run unattended to child PRs."),
});

export const epicResultSchema = z.object({
  phase: z.string(),
  integrationBranch: z.string(),
  prUrl: z.string(),
  summary: z.string(),
});

// Mirror of rig-task's designated result — the shape each child's inline TaskFlow terminal writes.
const childRunSchema = z.object({
  outcome: z.string(),
  unit: z.string(),
  prUrl: z.string(),
  testsGreen: z.boolean(),
  reviewState: z.string(),
  summary: z.string(),
});

// EpicFlow's own output tables. Registered via `epicSchemas(ns?)`; the child task
// tables are registered separately by the composer via `taskSchemas("child")`.
export const EPIC_TABLES = {
  epicPreflight: z.object({
    baseRef: z.string(),
    defaultBranch: z.string(),
    trackerProvider: z.string(),
    integrationBranch: z.string(),
    parent: z.string(),
    whyEpic: z.string(),
    childrenJson: z.string(),
    source: z.string(),
    banner: z.string(),
  }),
  plan: z.object({
    parent: z.string(),
    parentTitle: z.string(),
    integrationBranch: z.string(),
    whyEpic: z.string(),
    childrenJson: z.string(),
    summary: z.string(),
  }),
  start: z.object({ integrationBranch: z.string(), stateFile: z.string(), summary: z.string() }),
  specDirection: z.object({ proceed: z.boolean(), direction: z.string() }),
  epicSpec: z.object({ role: z.string(), blockers: z.array(z.string()), notes: z.string() }),
  childRun: childRunSchema,
  merge: z.object({ childId: z.string(), merged: z.boolean(), prUrl: z.string(), detail: z.string() }),
  reviewLens: z.object({ lens: z.string(), p0p1: z.number().int(), p2: z.number().int(), findings: z.string() }),
  reviewConsolidated: z.object({ p0p1: z.number().int(), p2: z.number().int(), clean: z.boolean(), report: z.string() }),
  reviewApproval: z.object({ approved: z.boolean() }),
  reviewFix: z.object({ summary: z.string() }),
  finishApproval: z.object({ approved: z.boolean() }),
  squashPr: z.object({ number: z.number().int(), url: z.string() }),
  epicResult: epicResultSchema,
};

const EPIC_KEYS = Object.keys(EPIC_TABLES) as (keyof typeof EPIC_TABLES)[];
const nsKey = (ns: string, k: string) => (ns ? `${ns}_${k}` : k);

/** Register EpicFlow's schemas, optionally namespaced (rig-crank namespaces to avoid its task-branch tables). */
export const epicSchemas = (ns = ""): Record<string, any> =>
  Object.fromEntries(Object.entries(EPIC_TABLES).map(([k, v]) => [nsKey(ns, k), v]));

/** Build the epic `tables` bag from a registry that registered `epicSchemas(ns)`. */
export const epicBag = (outputs: any, ns = ""): Record<string, any> =>
  Object.fromEntries(EPIC_KEYS.map((k) => [k, outputs[nsKey(ns, k)]]));

const SKILL = ".claude/skills/rig-epic/SKILL.md";

/** Kahn topological sort over blockedBy edges; falls back to declaration order on a cycle. */
function topoOrder(children: Child[]): Child[] {
  const byId = new Map(children.map((c) => [c.id, c]));
  const indeg = new Map(children.map((c) => [c.id, 0]));
  for (const c of children) {
    for (const dep of c.blockedBy) {
      if (byId.has(dep)) indeg.set(c.id, (indeg.get(c.id) ?? 0) + 1);
    }
  }
  const queue = children.filter((c) => (indeg.get(c.id) ?? 0) === 0);
  const ordered: Child[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    ordered.push(c);
    for (const other of children) {
      if (other.blockedBy.includes(c.id)) {
        indeg.set(other.id, (indeg.get(other.id) ?? 0) - 1);
        if ((indeg.get(other.id) ?? 0) === 0) queue.push(other);
      }
    }
  }
  return ordered.length === children.length ? ordered : children;
}

function parseChildren(json: string | undefined): Child[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? raw.map((r) => childSchema.parse({ blockedBy: [], ...r })) : [];
  } catch {
    return [];
  }
}

type EpicFlowProps = {
  input: z.infer<typeof epicInputSchema>;
  ctx: any;
  tables: Record<string, any>; // epic tables bag (see epicBag)
  childTables: Record<string, any>; // task bag the inline child TaskFlows write to (taskBag(outputs, tables.childRun, "child"))
};

export function EpicFlow({ input, ctx, tables, childTables }: EpicFlowProps) {
  const { phase, merge, advisor } = input;
  const isFull = phase === "full";
  // `full` is the continuous default: it drives plan→run→review→finish, pausing
  // ONLY at in-graph approval gates (no agent stitching phases together).
  // Plan only when a feature was given; an existing epic (parent + state) skips
  // straight to run/review/finish based on what's already merged.
  const doPlan = (phase === "plan" || isFull) && input.feature.trim() !== "";
  const doRun = phase === "run" || isFull;
  const doReview = phase === "review" || phase === "finish" || isFull; // review folds INTO finish
  const doFinish = phase === "finish" || isFull;

  const pre = ctx.outputMaybe(tables.epicPreflight, { nodeId: "epic-preflight" });
  const planRow = ctx.outputMaybe(tables.plan, { nodeId: "plan" });
  const startRow = ctx.outputMaybe(tables.start, { nodeId: "start" });

  // The integration branch + children come from the plan (fresh) or the state file (existing epic).
  const integrationBranch = planRow?.integrationBranch || pre?.integrationBranch || "";
  const children = topoOrder(parseChildren(planRow?.childrenJson ?? pre?.childrenJson));

  // A child counts as merged if the state file already says so, or its run-loop merge node recorded it.
  const merged = (c: Child) => c.status === "merged" || ctx.outputMaybe(tables.merge, { nodeId: `merge-${c.id}` })?.merged === true;
  const allMerged = children.length > 0 && children.every(merged);
  const startedFresh = doPlan; // a fresh plan cuts the branch first

  // FRONT-LOADED SPEC REVIEW: review ALL children's specs up front (architect + qa),
  // gate on ONE approval, then run children with their own spec gate OFF. (Children are
  // now inline TaskFlows in this one run, so a pause no longer FAILS the epic the way a
  // childRun Subflow did — but front-loading still avoids stalling the drain on a gate.)
  // Node ids follow GatherAndSynthesize's convention (`${id}-gather-${source}` and
  // `${id}-synthesize`) so the advisor path (a composed GatherAndSynthesize) and the
  // human path (hand-rolled, same ids) share one set of derived flags below.
  const specArch = ctx.outputMaybe(tables.epicSpec, { nodeId: "epic-spec-gather-architect" });
  const specQa = ctx.outputMaybe(tables.epicSpec, { nodeId: "epic-spec-gather-qa" });
  const specReviewed = Boolean(specArch && specQa);
  const specBlockers = [...(specArch?.blockers ?? []), ...(specQa?.blockers ?? [])];
  const specHasBlockers = specBlockers.length > 0;
  // The spec gate produces free-form direction (not just approve/deny): a human
  // (HumanTask) by default, or a Fable advisor (Task) when `advisor` is set for
  // unattended runs. Either way `direction` is threaded into every child's coder;
  // `proceed` gates execution (false = halt with a blocked report).
  const specDir = ctx.outputMaybe(tables.specDirection, { nodeId: "epic-spec-synthesize" });
  const specAnswered = Boolean(specDir);
  const runApproved = specDir?.proceed === true;
  const direction = specDir?.direction ?? "";
  // Spec review can run once the branch + children are known (start done for a fresh epic).
  const specReviewReady = doRun && integrationBranch !== "" && children.length > 0 && !allMerged && (!startedFresh || Boolean(startRow));
  // Children execute only after the human answers the spec gate with proceed=true.
  const readyToRun = specReviewReady && specReviewed && runApproved;

  const consolidated = ctx.outputMaybe(tables.reviewConsolidated, { nodeId: "review-consolidate" });
  const reviewClean = consolidated?.clean === true;
  const reviewApproved = ctx.outputMaybe(tables.reviewApproval, { nodeId: "approve-review" })?.approved === true;
  // Review runs once all children are in (or immediately for an already-merged epic).
  const reviewReady = doReview && integrationBranch !== "" && allMerged;

  const finishGatePassed = reviewClean || reviewApproved; // review is a HARD gate before the squash PR
  const finishApproved = isFull ? ctx.outputMaybe(tables.finishApproval, { nodeId: "approve-finish" })?.approved === true : true;
  const finishReady = doFinish && finishGatePassed && (!isFull || finishApproved);

  const cd = integrationBranch ? `The integration branch is \`${integrationBranch}\`.` : "";

  return (
    <>
      {/* Resolve config + (for run/review/finish) the active epic state file. */}
      <Task id="epic-preflight" output={tables.epicPreflight} retries={0}>
        {async () => {
          const def = { baseRef: "origin/main", defaultBranch: "main", trackerProvider: "none" };
          let cfg: any = {};
          try {
            cfg = JSON.parse(readFileSync(resolve(process.cwd(), ".rig/config.json"), "utf8"));
          } catch {
            /* unconfigured fallback */
          }
          // For run/review/finish, read the epic state file. Search THIS worktree and
          // (fallback) the main checkout, since /rig-epic may have been run elsewhere.
          let integrationBranch = "";
          let parent = input.parent;
          let whyEpic = "";
          let childrenJson = "[]";
          let source = "none";
          const epicDirs = [resolve(process.cwd(), ".rig/epics")];
          try {
            const { execSync } = await import("node:child_process");
            // The main worktree's .git parent → its .rig/epics.
            const commonGit = execSync("git rev-parse --path-format=absolute --git-common-dir", { encoding: "utf8" }).trim();
            const mainRepo = resolve(commonGit, "..");
            const mainEpics = resolve(mainRepo, ".rig/epics");
            if (!epicDirs.includes(mainEpics)) epicDirs.push(mainEpics);
          } catch {
            /* not a git repo / git missing — cwd dir only */
          }
          try {
            const { readdirSync, existsSync } = await import("node:fs");
            for (const dir of epicDirs) {
              if (!existsSync(dir)) continue;
              const files = (readdirSync(dir) as string[]).filter((f) => f.endsWith(".json"));
              // A NAMED parent only matches a state file that references it (case-insensitive:
              // parent may be the ticket id `ABC-42` or the branch slug `abc-42-…`). Never
              // fall back to "the single existing file" when a parent is named — that would
              // hijack a DIFFERENT epic's state (e.g. two epics running in parallel).
              const needle = input.parent.trim().toLowerCase();
              const pick = needle
                ? files.find((f) => f.toLowerCase().includes(needle))
                : files.length === 1
                  ? files[0]
                  : undefined;
              if (pick) {
                const state = JSON.parse(readFileSync(resolve(dir, pick), "utf8"));
                integrationBranch = state.integrationBranch ?? pick.replace(/\.json$/, "");
                parent = state.parent ?? parent;
                whyEpic = state.whyEpic ?? "";
                childrenJson = JSON.stringify(state.children ?? []);
                source = "state-file";
                break;
              }
            }
          } catch {
            /* no state file yet — plan will create one */
          }
          // Last resort: no state file, but the caller named the integration branch via `parent`.
          if (integrationBranch === "" && input.parent.trim() !== "") {
            integrationBranch = input.parent.trim();
            source = "input-parent";
          }
          const banner = `rig-epic: ${input.phase} — ${integrationBranch ? `epic ${integrationBranch}` : input.feature || "(new epic)"}. PRs target ${integrationBranch || "the integration branch"}, not the trunk. Will not auto-merge the trunk without --merge.`;
          return {
            baseRef: cfg?.vcs?.baseRef ?? def.baseRef,
            defaultBranch: cfg?.vcs?.defaultBranch ?? def.defaultBranch,
            trackerProvider: cfg?.tracker?.provider ?? def.trackerProvider,
            integrationBranch,
            parent,
            whyEpic,
            childrenJson,
            source,
            banner,
          };
        }}
      </Task>

      {/* ── plan + start ── */}
      {doPlan ? (
        <Sequence>
          <Task id="plan" agent={ROLE.architect} output={tables.plan} deps={{ "epic-preflight": tables.epicPreflight }}>
            {(d: any) => {
              const p = d["epic-preflight"];
              const namedParent = (input.parent || p.parent || "").trim();
              return `You are executing the \`plan\` step of the /rig-epic skill. Read ${SKILL} and \`.rig/config.json\` first.

**FIRST decide adopt vs decompose:**
${namedParent ? `A parent is named: \`${namedParent}\`. Fetch it from the tracker (${p.trackerProvider}). If it ALREADY EXISTS and has child issues, **ADOPT — do NOT decompose or create anything**: list its children (Linear: \`list_issues parentId=${namedParent}\`), and return them verbatim as \`childrenJson\` = JSON array of {id, title, blockedBy:[...], status}. Derive \`blockedBy\` from the children's tracker relations, or (if none are set) from the stack order in the parent's description (each later child blocked by the first/foundational one). Set parentTitle from the parent, whyEpic from its description, and propose the integration branch name \`<parent-slug>-<title-slug>\` (kebab). Skip steps 1-4 below. If the named parent does NOT exist yet, fall through to decompose.` : `No parent named — decompose the feature below into a new epic.`}

Otherwise, decompose this feature into a parent + 3-8 children:
"${input.feature}"

1. Read product/spec docs and explore the codebase (sourceScope) to see what exists; in a tracker, search for near-duplicate items first.
2. SANITY-CHECK it is genuinely epic-shaped — at least one child's runtime contract depends on another being only partially complete (the interleave test). If the items are independent, STOP and say it should be a /rig-sprint instead (return an empty children list and explain in whyEpic).
3. Create the parent (tracker: ${p.trackerProvider}) and each child with concrete, testable acceptance criteria, small enough for one agent session (1-3 files), foundational work first.
4. Record \`blockedBy\` for EVERY real dependency — this drives execution order.
5. Propose the integration branch name \`<parent-slug>-<title-slug>\` (kebab).

Return: parent (id or slug), parentTitle, integrationBranch, whyEpic, and childrenJson = a JSON array string of {id, title, blockedBy:[...], status}.`;
            }}
          </Task>
          <Task id="start" agent={ROLE.coord} output={tables.start} deps={{ plan: tables.plan, "epic-preflight": tables.epicPreflight }}>
            {(d: any) => {
              const pl = d["plan"];
              const p = d["epic-preflight"];
              return `You are executing the \`start\` step of the /rig-epic skill (${SKILL}). Print the intent banner first.

1. \`git fetch origin\`; confirm the parent and >=1 child exist.
2. Cut the integration branch \`${pl.integrationBranch}\` from \`${p.baseRef}\` WITHOUT a local checkout, and non-destructively (leave it if it already exists):
   git push origin ${p.baseRef}:refs/heads/${pl.integrationBranch}
3. Write \`.rig/epics/${pl.integrationBranch}.json\` with { parent, parentTitle, integrationBranch, whyEpic, children:[{id,title,blockedBy,branch:null,status:"todo"}] } using the plan's data:
   parent=${pl.parent}; whyEpic=${JSON.stringify(pl.whyEpic)}; children=${pl.childrenJson}
   Ensure \`.rig/epics/\` is in .gitignore.
4. In a tracker, add an "Integration branch: target \`${pl.integrationBranch}\`, not the trunk" note to each child, and ensure the PARENT is In Progress (adaptive: \`get_issue\`; if not already started, \`save_issue state="In Progress"\`). Children get their own In Progress from their rig-task Step 1.
5. Name the session "EPIC: ${pl.parentTitle} (${pl.parent})".

Return integrationBranch, the stateFile path, and a summary. Do NOT start executing children — that is an explicit opt-in.`;
            }}
          </Task>
        </Sequence>
      ) : null}

      {/* ── front-loaded spec review of ALL children, then ONE decision ──
          The advisor path is a composed <GatherAndSynthesize> (a tested Smithers
          primitive): a Parallel gather of the architect + qa specs, then a synthesis
          Task (the advisor) returning {proceed, direction}. Its synthesis `needs` both
          gathers, so it self-gates — we no longer hand-roll the specReviewed/specAnswered
          guard for this path. The human path keeps the SAME node ids
          (epic-spec-gather-{architect,qa}, epic-spec-synthesize) so the derived flags
          above stay path-agnostic. */}
      {specReviewReady ? (
        advisor ? (
          <GatherAndSynthesize
            id="epic-spec"
            sources={{
              architect: {
                agent: ROLE.architect,
                prompt: `Front-loaded ARCHITECT spec review for the epic on ${integrationBranch} (${SKILL}). ${cd} Fetch EVERY child's spec from the tracker (${children.map((c) => c.id).join(", ")}) and review each for implementability AGAINST the integration branch (inspect it: \`git fetch origin\`; the terminal service + prior children live on \`${integrationBranch}\`). Flag ambiguities, missing acceptance criteria, and cross-child ordering issues. Return role="architect", notes (per child), and a \`blockers\` array of ONLY things that must be resolved before ANY coding starts — prefix each with the child id (e.g. "CEX-542: gap semantics undefined vs the shared sequencer …").`,
              },
              qa: {
                agent: ROLE.reviewer,
                prompt: `Front-loaded QA spec review for the epic on ${integrationBranch} (${SKILL}). ${cd} Fetch EVERY child's spec (${children.map((c) => c.id).join(", ")}) and review each from a testing perspective against the integration branch. Return role="qa", notes, and a \`blockers\` array of ONLY untestable/contradictory criteria that must be fixed before coding — prefix each with the child id.`,
              },
            }}
            synthesizer={ROLE.advisor}
            gatherOutput={tables.epicSpec}
            synthesisOutput={tables.specDirection}
            synthesisPrompt={`You are the ARCH ADVISOR for the epic on \`${integrationBranch}\` (${SKILL}). ${cd} You stand in for the human at the front-loaded spec gate: BEFORE ${children.length} parallel implementation runs (${children.map((c) => c.id).join(", ")}) commit against the integration branch, you decide whether to proceed and produce the steering direction every child's coder will follow. No human is waiting — you ARE the gate.

Two independent front-loaded reviews just ran against \`${integrationBranch}\`:
- ARCHITECT — notes: ${JSON.stringify(specArch?.notes ?? "")}
- QA — notes: ${JSON.stringify(specQa?.notes ?? "")}
${
  specHasBlockers
    ? `Flagged blocker(s) (${specBlockers.length}):\n- ${specBlockers.join("\n- ")}`
    : "Neither reviewer flagged a blocker."
}

Judge ADVERSARIALLY — a paused child fails the whole epic, and fanning ${children.length} runs out on a bad spec wastes real compute:
- Verify against the branch if useful (\`git fetch origin\`; the terminal service + any prior children live on \`${integrationBranch}\`).
- proceed=true ONLY if the specs are coherent, each child is well-scoped, and there is NO contradiction or missing decision that would make the parallel tasks diverge or need rework. Then set \`direction\` to concrete per-child guidance (prefix each with the child id, e.g. "CEX-543: funding line = rate+countdown") that resolves every flagged item — this is handed verbatim to each child's coder.
- proceed=false if there is a genuine blocker that must be resolved before ANY coding. Put the specific blocking reason(s) and what a human must decide into \`direction\`; the epic HALTS with that as its blocked report.

Return JSON: {"proceed": <bool>, "direction": "<per-child steering, or the blocking reasons if proceed=false>"}`}
          />
        ) : (
          <Sequence>
            <Parallel id="epic-spec-gather">
              <Task id="epic-spec-gather-architect" agent={ROLE.architect} output={tables.epicSpec} deps={{ "epic-preflight": tables.epicPreflight }}>
                {() => `Front-loaded ARCHITECT spec review for the epic on ${integrationBranch} (${SKILL}). ${cd} Fetch EVERY child's spec from the tracker (${children.map((c) => c.id).join(", ")}) and review each for implementability AGAINST the integration branch (inspect it: \`git fetch origin\`; the terminal service + prior children live on \`${integrationBranch}\`). Flag ambiguities, missing acceptance criteria, and cross-child ordering issues. Return role="architect", notes (per child), and a \`blockers\` array of ONLY things that must be resolved before ANY coding starts — prefix each with the child id (e.g. "CEX-542: gap semantics undefined vs the shared sequencer …").`}
              </Task>
              <Task id="epic-spec-gather-qa" agent={ROLE.reviewer} output={tables.epicSpec} deps={{ "epic-preflight": tables.epicPreflight }}>
                {() => `Front-loaded QA spec review for the epic on ${integrationBranch} (${SKILL}). ${cd} Fetch EVERY child's spec (${children.map((c) => c.id).join(", ")}) and review each from a testing perspective against the integration branch. Return role="qa", notes, and a \`blockers\` array of ONLY untestable/contradictory criteria that must be fixed before coding — prefix each with the child id.`}
              </Task>
            </Parallel>
            {specReviewed && !specAnswered ? (
              <HumanTask
                id="epic-spec-synthesize"
                output={tables.specDirection}
                prompt={`Front-loaded spec review of ${children.length} children (${children.map((c) => c.id).join(", ")}) on \`${integrationBranch}\`.\n\n${
                  specHasBlockers
                    ? `Found ${specBlockers.length} item(s) needing your direction:\n\n- ${specBlockers.join("\n- ")}\n\n`
                    : "No blockers found.\n\n"
                }Type direction that will be handed to EVERY child's coder (address the items above — e.g. "CEX-543: funding line = rate+countdown", "CEX-546: risk panel against RiskFrameSchema fixtures"). Then set proceed=true to execute all children uninterrupted, or proceed=false to halt.\n\nAnswer with JSON, e.g.:\n{"proceed": true, "direction": "<your guidance across the children>"}`}
              />
            ) : null}
          </Sequence>
        )
      ) : null}

      {/* ── run: each child = rig-task against the integration branch, then a merge gate ── */}
      {readyToRun
        ? (() => {
            const lanes: React.ReactElement[] = [];
            for (let i = 0; i < children.length; i++) {
              const child = children[i];
              if (merged(child)) {
                continue; // already merged (state file or a prior lane) — its lane is done
              }
              if (i > 0 && !merged(children[i - 1])) {
                break; // previous child not merged yet — stop the chain here
              }
              // Depend on the previous child's merge gate ONLY while that child is
              // still in-flight. Once it's merged its lane is skipped (the `continue`
              // above), so a dependsOn on its now-unrendered `merge-<id>` node would
              // dangle and deadlock the fan-out (DEPENDENCY_DEADLOCK) — which is
              // a hazard when a prior child's merge node is skipped after it lands.
              const prevUnmerged = i > 0 && !merged(children[i - 1]);
              // Only one unmerged child lane renders at a time (the loop `break`s while
              // the previous child is in-flight), so the child TaskFlows are serialized by
              // render-gating — no dependsOn needed on a fragment. Each child's nodes are
              // namespaced by idPrefix `child-<id>-`; its terminal lands in tables.childRun.
              void prevUnmerged;
              lanes.push(
                <Sequence key={child.id}>
                  <TaskFlow
                    input={{ target: child.id, phase: "both", base: integrationBranch, local: false, autoMerge: true, specGate: false, specNotes: direction }}
                    ctx={ctx}
                    tables={childTables}
                    idPrefix={`child-${child.id}-`}
                  />
                  <Task id={`merge-${child.id}`} agent={ROLE.coord} output={tables.merge} deps={{ [`child-${child.id}-result`]: tables.childRun }}>
                    {(d: any) => {
                      const run = d[`child-${child.id}-result`];
                      return `You are the merge gate for epic child ${child.id} (${SKILL}). ${cd}

The child's rig-task run finished with outcome "${run.outcome}" (PR ${run.prUrl}) and, if clean, squash-merged it into the integration branch (or armed \`--squash --auto\` if a required check was pending).

ONLY "clean" is merge-green:
- "clean" → the child PR **squash-merges** into \`${integrationBranch}\` (directly when there are no required checks, else once they pass). Confirm/WAIT: poll \`gh pr view <N> --json state\` (~60s intervals, up to ~30min) until state=MERGED, then \`git fetch origin\` and confirm the integration tip advanced. Then: (a) update \`.rig/epics/${integrationBranch}.json\` — mark ${child.id} status="merged" + record its branch/PR; (b) ensure the child ticket ${child.id} is Done (adaptive — ignore the githubIntegration config flag: \`get_issue\`; if not already Done, \`save_issue state="Done"\`; if the integration already closed it, leave it). Return merged=true, the PR url, a short detail. If it never merges (checks failing) → merged=false with why.
- anything else ("actionable"/"timeout"/"blocked") → the child is not clean and did NOT enable auto-merge. Return merged=false with a detail; the epic stops here for a human.

Never force-push the integration branch (in-flight child PRs are based on its tip).`;
                    }}
                  </Task>
                </Sequence>,
              );
            }
            return <Sequence>{lanes}</Sequence>;
          })()
        : null}

      {/* ── review: combined-diff, three lenses in parallel (the hard gate before finish) ── */}
      {reviewReady ? (
        <Sequence>
          <Parallel id="review-lenses">
            <Task id="review-simplify" agent={ROLE.architect} output={tables.reviewLens} deps={{ "epic-preflight": tables.epicPreflight }}>
              {() => `Lens 1 — SIMPLIFICATION (/rig-epic review, ${SKILL}). ${cd} Ensure an integration-branch worktree, then diff \`git diff ${pre?.baseRef ?? "origin/main"}...HEAD\` and list merged child PRs (\`gh pr list --base ${integrationBranch} --state merged\`).

Find abstractions to collapse, helpers one PR added that another PR's final shape made redundant, config knobs nobody sets, code paths the combined diff made dead, one-caller types. Concrete deletions/merges with file:line, highest-impact first. Skip correctness. Return lens="simplify", counts p0p1/p2, and findings.`}
            </Task>
            <Task id="review-crosspr" agent={ROLE.reviewer} output={tables.reviewLens} deps={{ "epic-preflight": tables.epicPreflight }}>
              {() => `Lens 2 — CROSS-PR CORRECTNESS (/rig-epic review, ${SKILL}). ${cd} Walk the review-pattern catalog (.claude/REVIEWER.md) against the COMBINED diff \`git diff ${pre?.baseRef ?? "origin/main"}...HEAD\`.

Per-PR review already ran; catch interactions only visible at the merged shape (PR-A's helper vs PR-D's stale caller; PR-B removed a knob PR-F still reads). Return lens="crosspr", counts p0p1/p2, and findings with file:line + category.`}
            </Task>
            <Task id="review-deadcode" agent={ROLE.reviewer} output={tables.reviewLens} deps={{ "epic-preflight": tables.epicPreflight }}>
              {() => `Lens 3 — DEAD CODE & STALE REFS (/rig-epic review, ${SKILL}). ${cd} For the COMBINED diff \`git diff ${pre?.baseRef ?? "origin/main"}...HEAD\`: for every symbol added, is it called elsewhere? For every symbol removed, grep the whole tree (workflows, manifests, IaC, scripts, docs) for residual refs. Return lens="deadcode", counts p0p1/p2, and findings with file:line.`}
            </Task>
          </Parallel>
          <Task id="review-consolidate" agent={ROLE.reviewer} output={tables.reviewConsolidated} dependsOn={["review-simplify", "review-crosspr", "review-deadcode"]}>
            {() => `Consolidate the three review lenses for the epic on ${integrationBranch} (${SKILL}). Read each lens's output row, dedupe, and produce ONE P0/P1/P2 list grouped by lens with counts. Set clean=true only when there are zero P0/P1. Return p0p1, p2, clean, and the grouped report.`}
          </Task>
          {consolidated && !consolidated.clean ? (
            <Approval
              id="approve-review"
              output={tables.reviewApproval}
              onDeny="fail"
              request={{
                title: `Combined-diff review found ${consolidated.p0p1} P0/P1 + ${consolidated.p2} P2 on ${integrationBranch}`,
                summary: `${consolidated.report}\n\nApprove to APPLY fixes now (runs /rig-review fix on the integration branch), or deny to pause.`,
              }}
            />
          ) : null}
          {consolidated && !consolidated.clean && reviewApproved ? (
            <Task id="review-fix" agent={ROLE.coder} output={tables.reviewFix} deps={{ "review-consolidate": tables.reviewConsolidated }}>
              {(d: any) => `Apply the combined-diff review fixes on ${integrationBranch} (/rig-review fix --source local, ${SKILL}). ${cd} Fix the P0/P1 items, keep tests green, commit, and \`git push origin ${integrationBranch}\`.

Findings:
${d["review-consolidate"].report}

Return a summary of what you changed.`}
            </Task>
          ) : null}
        </Sequence>
      ) : null}

      {/* ── full-only gate before the squash-to-trunk PR ── */}
      {phase === "full" && reviewReady && finishGatePassed ? (
        <Approval
          id="approve-finish"
          output={tables.finishApproval}
          onDeny="fail"
          request={{
            title: `Open the squash PR for ${integrationBranch} to the trunk?`,
            summary: `Review gate passed (${reviewClean ? "clean" : "fixes applied"}). Approve to open the single squash PR to ${pre?.defaultBranch ?? "main"}.${merge ? " It will be squash-merged (--merge)." : " It will stop at an open PR for a human to merge."}`,
          }}
        />
      ) : null}

      {/* ── finish: squash the integration branch into one PR to the trunk ── */}
      {finishReady ? (
        <Task id="finish-squash" agent={ROLE.coord} output={tables.squashPr} deps={{ "epic-preflight": tables.epicPreflight }}>
          {(d: any) => {
            const p = d["epic-preflight"];
            return `You are executing \`finish\` of /rig-epic (${SKILL}). ${cd} Print the intent banner first. The review gate is a HARD precondition and has passed.

1. \`git fetch origin\`; if the trunk (${p.baseRef}) moved past \`${integrationBranch}\`, rebase the integration branch onto it (\`git rebase ${p.baseRef}\` on a local copy, then \`git push --force-with-lease origin <local>:${integrationBranch}\`).
2. Open the final squash PR to \`${p.defaultBranch}\` **NON-draft** with a title referencing the parent and a body summarizing all children. Include the closes-verb (\`Fixes <PARENT>\` / \`Closes #<n>\`) so the parent auto-closes. Then run \`gh pr ready <N>\` to POST it as ready-for-review (never leave it a draft).
3. Merge behavior: ${merge ? "run `gh pr merge <N> --squash --delete-branch --auto` so CI gates the squash-merge to the trunk; if protectedBranchMergeQueue, use `gh pr merge <N> --auto` with no method flag (the queue decides)." : "STOP at the open, ready PR — squashing to the trunk is the human gate. Do NOT merge."}
4. Parent Done (adaptive — do NOT trust the githubIntegration flag): ${merge ? "you are squash-merging, so once the PR is MERGED, ensure the parent is Done — `get_issue`; if not already Done, `save_issue state=\"Done\"`; the closes-verb also handles it if an integration is live (don't clobber)." : "you are stopping at the open PR, so leave the parent In Progress — the parent moves to Done when a human merges the squash PR (its `Fixes <PARENT>` closes it if the integration is live; otherwise a follow-up run reconciles it)."} Children were already set Done as they merged.
5. Delete the epic state file \`.rig/epics/${integrationBranch}.json\` once the work is ${merge ? "on the trunk" : "in its final PR"}.

Return the PR number and url.`;
          }}
        </Task>
      ) : null}

      {/* ── final report ── */}
      <Task id="epic-result" output={tables.epicResult} retries={0} dependsOn={["epic-preflight"]}>
        {() => {
          const sq = ctx.outputMaybe(tables.squashPr, { nodeId: "finish-squash" });
          const st = ctx.outputMaybe(tables.start, { nodeId: "start" });
          const branch = integrationBranch || pre?.integrationBranch || "";
          let summary: string;
          if (doFinish && sq) summary = `Epic ${branch}: squash PR ${sq.url} ${merge ? "squash-merged to trunk" : "open for human merge"}.`;
          else if (doReview && consolidated) summary = `Epic ${branch}: combined review ${consolidated.clean ? "clean" : `${consolidated.p0p1} P0/P1`} — ready for finish.`;
          else if (doRun && children.length) summary = `Epic ${branch}: ${children.filter(merged).length}/${children.length} children merged into the integration branch.`;
          else if (doPlan && st) summary = `Epic started on ${branch}: ${children.length} children planned. Next: rig-epic run (or full).`;
          else summary = pre?.banner ?? "rig-epic";
          return { phase, integrationBranch: branch, prUrl: sq?.url ?? "", summary };
        }}
      </Task>
    </>
  );
}
