/** @jsxImportSource react */
import { useState } from "react";
import type { CSSProperties } from "react";
import { createGatewayReactRoot, useGatewayRuns } from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  LaunchButton,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunList,
  RunMeta,
  RunTree,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";

const WORKFLOW = "rig-task";

/** The canonical rig-task pipeline, mirrored from the workflow graph. */
const STEPS: Array<[string, string]> = [
  ["preflight", "Resolve unit + .rig config"],
  ["setup", "Load spec · set up worktree"],
  ["spec-architect · spec-qa", "Spec review (parallel)"],
  ["approve-spec", "Blocker gate — pauses only if flagged"],
  ["red-step", "RED — failing tests first"],
  ["green-step", "GREEN — minimum impl (loop ×3)"],
  ["refactor-step", "REFACTOR — only while green"],
  ["review-find · review-fix", "Pre-PR self-review (loop)"],
  ["open-pr", "Push + open PR"],
  ["review-bot", "Review-bot loop (finish)"],
  ["result", "Hand back — never auto-merges"],
];

const border = "1px solid rgba(127,127,127,0.25)";
const cardStyle: CSSProperties = { border, borderRadius: 8, padding: 12 };

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function PipelineLegend({ label }: { label: string }) {
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.8 }}>Pipeline · {label}</h3>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
        {STEPS.map(([id, desc]) => (
          <li key={id}>
            <code style={{ fontSize: 11 }}>{id}</code>
            <span style={{ opacity: 0.7 }}> — {desc}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [nodeId, setNodeId] = useState<string | undefined>();

  // Follow the newest run when the URL didn't pin one.
  const latest = useGatewayRuns({ filter: { workflow: WORKFLOW, limit: 1 } });
  const latestData = latest.data as { runs?: Array<{ runId?: string }> } | Array<{ runId?: string }> | undefined;
  const latestRunId = Array.isArray(latestData) ? latestData[0]?.runId : latestData?.runs?.[0]?.runId;
  const activeRunId = runId ?? latestRunId;

  return (
    <WorkflowUiShell
      title="rig-task — implement one unit end-to-end"
      meta={<RunMeta runId={activeRunId} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ConnectionBadge />
          <LaunchButton workflow={WORKFLOW} input={{ phase: "both" }} onLaunched={setRunId}>
            Launch rig-task
          </LaunchButton>
          <MonitorButton runId={activeRunId} />
        </div>
      }
    >
      {/* Pending approvals (spec-review blocker gate, etc.) — first thing you see. */}
      <section style={{ ...cardStyle, marginBottom: 12, borderColor: "rgba(230,160,30,0.6)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.85 }}>⚠ Approvals &amp; blockers</h3>
        <ApprovalPanel filter={{ workflow: WORKFLOW }} />
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(200px, 250px) minmax(260px, 1fr) minmax(320px, 1.4fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <RunList
            filter={{ workflow: WORKFLOW, limit: 20 }}
            activeRunId={activeRunId}
            onSelect={(id) => {
              setRunId(id);
              setNodeId(undefined);
            }}
          />
          <PipelineLegend label="TDD → PR → review" />
        </div>

        <RunTree runId={activeRunId} activeNodeId={nodeId} onSelectNode={(node) => setNodeId(node.id)} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <NodeChatStream runId={activeRunId} nodeId={nodeId} height={380} />
          <NodeOutputView runId={activeRunId} nodeId={nodeId} />
        </div>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
