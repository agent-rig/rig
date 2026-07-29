/** @jsxImportSource react */
import { useState } from "react";
import type { CSSProperties } from "react";
import {
  createGatewayReactRoot,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
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
  StatusPill,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";

const WORKFLOW = "rig-epic";

// A selected node lives in a specific run — the epic OR one of its child sub-runs.
type Sel = { runId: string; nodeId: string };

const border = "1px solid rgba(127,127,127,0.25)";
const cardStyle: CSSProperties = { border, borderRadius: 8, padding: 12 };

// Subflow children are minted as `run-<parent>:child:<node>:<iter>`. The gateway's
// run-TREE RPC (what <RunTree> uses) rejects those colons at a validateRunId regex,
// so it can't render a child. getRun + the event stream are NOT gated, so we drive
// the child view from those instead (same data `smithers inspect` / the /monitor
// timeline see).
const EV_TO_STATUS: Record<string, string> = {
  NodePending: "queued",
  NodeStarted: "running",
  NodeRetrying: "running",
  NodeFinished: "ok",
  NodeFailed: "failed",
  NodeCancelled: "cancelled",
  NodeSkipped: "ok",
  NodeWaitingApproval: "waiting",
  NodeWaitingEvent: "waiting",
  NodeWaitingTimer: "waiting",
};

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function asRunArray(data: unknown): Array<Record<string, any>> {
  if (Array.isArray(data)) return data as Array<Record<string, any>>;
  const runs = (data as { runs?: unknown } | undefined)?.runs;
  return Array.isArray(runs) ? (runs as Array<Record<string, any>>) : [];
}

/** `run-123:child:child-CEX-526:0` -> "CEX-526" (or "CEX-526 · retry 1"). */
function childLabel(runId: string): string {
  const m = runId.match(/:child:(.+):(\d+)$/);
  if (!m) return runId;
  const ticket = m[1].replace(/^child-/, "");
  const iter = Number(m[2]);
  return iter > 0 ? `${ticket} · retry ${iter}` : ticket;
}

/** Fold the child's lifecycle events into a per-node status list (latest wins). */
function useChildNodes(childId: string): Array<{ id: string; status: string }> {
  const { events } = useGatewayRunEvents(childId, { maxEvents: 5000 });
  const byNode = new Map<string, string>();
  for (const f of events ?? []) {
    const p = (f as any).payload as { type?: string; nodeId?: string } | undefined;
    const evType = p?.type ?? (f as any).event;
    const status = evType ? EV_TO_STATUS[evType] : undefined;
    if (!p?.nodeId || !status) continue;
    byNode.set(p.nodeId, status); // Map keeps first-seen order; value = latest status
  }
  return [...byNode.entries()].map(([id, status]) => ({ id, status }));
}

/** One child rig-task sub-run: live status via getRun, node tree via events. */
function ChildTask({
  childId,
  rowStatus,
  sel,
  onSelect,
}: {
  childId: string;
  rowStatus: string;
  sel: Sel | undefined;
  onSelect: (s: Sel) => void;
}) {
  const { data: run } = useGatewayRun(childId);
  // The list's row status is stale (queued); the computed runState is authoritative.
  const status =
    (run?.runState as { state?: string } | undefined)?.state ?? (run?.status as string | undefined) ?? rowStatus;
  const nodes = useChildNodes(childId);
  const active = sel?.runId === childId;

  return (
    <details open={active} style={{ ...cardStyle, padding: 8 }}>
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, listStyle: "none" }}>
        <strong style={{ fontSize: 12 }}>{childLabel(childId)}</strong>
        <StatusPill status={status} />
        <code style={{ fontSize: 10, opacity: 0.45, marginLeft: "auto" }}>{childId}</code>
      </summary>
      <div style={{ marginTop: 8 }}>
        {nodes.length === 0 ? (
          <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>Waiting for the first node events…</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {nodes.map((n) => {
              const selected = active && sel?.nodeId === n.id;
              return (
                <li
                  key={n.id}
                  onClick={() => onSelect({ runId: childId, nodeId: n.id })}
                  style={{
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "2px 6px",
                    borderRadius: 6,
                    background: selected ? "rgba(127,127,127,0.15)" : "transparent",
                  }}
                >
                  <StatusPill status={n.status} />
                  <code style={{ fontSize: 12 }}>{n.id}</code>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

function ChildTasks({
  epicRunId,
  sel,
  onSelect,
}: {
  epicRunId: string | undefined;
  sel: Sel | undefined;
  onSelect: (s: Sel) => void;
}) {
  const all = useGatewayRuns({ filter: { limit: 200 } });
  const children = asRunArray(all.data)
    .filter((r) => epicRunId && String(r.parentRunId ?? "") === epicRunId)
    .sort((a, b) => Number(a.createdAtMs ?? 0) - Number(b.createdAtMs ?? 0));

  return (
    <section style={cardStyle}>
      <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.85 }}>
        Child tasks — rig-task sub-runs ({children.length})
        <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 400 }}> · event-derived (tree RPC can't address child ids)</span>
      </h3>
      {children.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>
          None yet — child runs appear here once the advisor proceeds and the epic fans out.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {children.map((c) => (
            <ChildTask
              key={String(c.runId)}
              childId={String(c.runId)}
              rowStatus={String(c.status ?? "")}
              sel={sel}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [sel, setSel] = useState<Sel | undefined>();

  const latest = useGatewayRuns({ filter: { workflow: WORKFLOW, limit: 1 } });
  const latestRunId = asRunArray(latest.data)[0]?.runId as string | undefined;
  const activeRunId = runId ?? latestRunId;

  const selectEpicRun = (id: string) => {
    setRunId(id);
    setSel(undefined);
  };

  return (
    <WorkflowUiShell
      title="rig-epic — epic + child-task tree"
      meta={<RunMeta runId={activeRunId} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ConnectionBadge />
          <LaunchButton workflow={WORKFLOW} input={{ phase: "plan" }} onLaunched={selectEpicRun}>
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
          gridTemplateColumns: "minmax(190px, 230px) minmax(300px, 1.1fr) minmax(320px, 1.3fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <RunList filter={{ workflow: WORKFLOW, limit: 20 }} activeRunId={activeRunId} onSelect={selectEpicRun} />

        {/* Epic tree (top-level id → RunTree is fine) + the event-derived child trees. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <section style={cardStyle}>
            <h3 style={{ margin: "0 0 8px", fontSize: 13, opacity: 0.85 }}>Epic</h3>
            <RunTree
              runId={activeRunId}
              activeNodeId={sel?.runId === activeRunId ? sel?.nodeId : undefined}
              onSelectNode={(n) => activeRunId && setSel({ runId: activeRunId, nodeId: n.id })}
            />
          </section>
          <ChildTasks epicRunId={activeRunId} sel={sel} onSelect={setSel} />
        </div>

        {/* Output pane — follows the selected node in whichever run it belongs to. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            {sel ? (
              <span>
                Viewing <code>{sel.nodeId}</code> in{" "}
                <code>{sel.runId === activeRunId ? "epic" : childLabel(sel.runId)}</code>
              </span>
            ) : (
              "Select a node — from the epic or any child task — to see its output."
            )}
          </div>
          <NodeChatStream runId={sel?.runId} nodeId={sel?.nodeId} height={360} />
          <NodeOutputView runId={sel?.runId} nodeId={sel?.nodeId} />
        </div>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
