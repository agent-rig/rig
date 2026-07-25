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

const WORKFLOW = "rig-epic";

/** The canonical rig-epic arc, mirrored from the workflow graph. */
const STEPS: Array<[string, string]> = [
  ["epic-preflight", "Resolve config + active epic state file"],
  ["plan", "Decompose feature → parent + children (blockedBy)"],
  ["start", "Cut integration branch · write state file"],
  ["approve-run", "Gate — execution is an explicit opt-in"],
  ["child-* → merge-*", "Each child via rig-task, stacked, then merge-gated"],
  ["review-lenses", "Combined diff: simplify · cross-PR · dead-code"],
  ["review-consolidate", "One P0/P1/P2 list; apply-or-pause gate"],
  ["approve-finish", "Gate before the squash-to-trunk PR"],
  ["finish-squash", "Squash PR to the trunk (merge only with --merge)"],
  ["epic-result", "Report — never auto-merges the trunk"],
];

const border = "1px solid rgba(127,127,127,0.25)";
const cardStyle: CSSProperties = { border, borderRadius: 8, padding: 12 };

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function ArcLegend() {
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.8 }}>Arc · plan → run → review → finish</h3>
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

  const latest = useGatewayRuns({ filter: { workflow: WORKFLOW, limit: 1 } });
  const latestData = latest.data as { runs?: Array<{ runId?: string }> } | Array<{ runId?: string }> | undefined;
  const latestRunId = Array.isArray(latestData) ? latestData[0]?.runId : latestData?.runs?.[0]?.runId;
  const activeRunId = runId ?? latestRunId;

  return (
    <WorkflowUiShell
      title="rig-epic — integration-branch workflow"
      meta={<RunMeta runId={activeRunId} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ConnectionBadge />
          <LaunchButton workflow={WORKFLOW} input={{ phase: "plan" }} onLaunched={setRunId}>
            Launch rig-epic
          </LaunchButton>
          <MonitorButton runId={activeRunId} />
        </div>
      }
    >
      {/* Pending approvals (run/review/finish gates) — first thing you see. */}
      <section style={{ ...cardStyle, marginBottom: 12, borderColor: "rgba(230,160,30,0.6)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.85 }}>⚠ Approvals &amp; blockers</h3>
        <ApprovalPanel filter={{ workflow: WORKFLOW }} />
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(210px, 260px) minmax(260px, 1fr) minmax(320px, 1.4fr)",
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
          <ArcLegend />
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
