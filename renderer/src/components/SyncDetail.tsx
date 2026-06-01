import { ArrowRight, Shield } from "lucide-react";
import type { JsonRecord, SyncMode } from "../../../src/types";

type SyncItem = {
  id: SyncMode;
  title: string;
  count: number;
  description: string;
  actionLabel: string;
  tone: "primary" | "danger";
  groups: JsonRecord[];
};

function splitProviderFlow(value: unknown, fallbackTarget: string): { from: string; to: string } {
  const text = String(value ?? "-");
  const marker = " -> ";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return { from: text, to: fallbackTarget || "-" };
  }
  return {
    from: text.slice(0, markerIndex) || "-",
    to: text.slice(markerIndex + marker.length) || fallbackTarget || "-"
  };
}

function SyncDetail({ item, activeProvider, working = false, onRun }: {
  item: SyncItem | undefined;
  activeProvider: string;
  working?: boolean;
  onRun: (item: SyncItem) => void;
}) {
  if (!item) {
    return <div className="detail-empty"><Shield size={28} /><p>Select a sync task.</p></div>;
  }
  const isRepair = item.id === "repair";
  const canRun = !working && item.count > 0 && (isRepair || Boolean(activeProvider));
  const targetLabel = activeProvider || "-";
  return (
    <div className="detail sync-detail">
      <div className="sync-summary">
        <span className={`badge ${item.count ? "warn" : "ok"}`}>{item.count ? `${item.count} affected` : "clean"}</span>
        <p>{item.description}</p>
      </div>
      <div className="kv">
        <span>Current runtime</span><strong>{activeProvider || "-"}</strong>
        <span>Affected chats</span><strong>{item.count}</strong>
        <span>Backup</span><strong>created before apply</strong>
      </div>
      <div className="sync-group-list">
        <div className="sync-title">{isRepair ? "Conflicting provider tags" : "Manual runtime retag candidates"}</div>
        {item.groups.map((group: JsonRecord) => {
          const flow = splitProviderFlow(group.provider, isRepair ? String(group.targetProvider ?? "") : targetLabel);
          return (
          <div className="sync-flow-row" key={`${group.provider}:${group.count}`}>
            <div className="sync-flow-node">
              <span>From</span>
              <strong>{flow.from}</strong>
            </div>
            <ArrowRight size={14} />
            <div className="sync-flow-node to">
              <span>To</span>
              <strong>{flow.to}</strong>
            </div>
            <em>{group.count} chat{group.count === 1 ? "" : "s"}</em>
          </div>
          );
        })}
        {!item.groups.length && <div className="file-empty">No chats need this sync task.</div>}
      </div>
      <div className="actions">
        <button className={item.tone === "danger" ? "danger" : "primary"} onClick={() => onRun(item)} disabled={!canRun} type="button">
          <Shield size={15} /> {working ? "Working..." : item.actionLabel}
        </button>
      </div>
    </div>
  );
}

export { SyncDetail };
