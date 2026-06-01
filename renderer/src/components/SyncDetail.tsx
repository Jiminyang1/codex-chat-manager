import { Shield } from "lucide-react";
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

function SyncDetail({ item, activeProvider, onRun }: {
  item: SyncItem | undefined;
  activeProvider: string;
  onRun: (item: SyncItem) => void;
}) {
  if (!item) {
    return <div className="detail-empty"><Shield size={28} /><p>Select a sync task.</p></div>;
  }
  const isRepair = item.id === "repair";
  const canRun = item.count > 0 && (isRepair || Boolean(activeProvider));
  return (
    <div className="detail">
      <div className="detail-title">
        <h2>{item.title}</h2>
        <span className={`badge ${item.count ? "warn" : "ok"}`}>{item.count ? `${item.count} pending` : "clean"}</span>
      </div>
      <div className="kv">
        <span>Mode</span><strong>{isRepair ? "Repair metadata" : "Retag chats"}</strong>
        <span>Active provider</span><strong>{activeProvider || "-"}</strong>
        <span>Affected chats</span><strong>{item.count}</strong>
        <span>Backup</span><strong>created before apply</strong>
      </div>
      <div className="backup-note">{item.description}</div>
      <div className="sync-group-list">
        <div className="sync-title">{isRepair ? "Mismatch groups" : "Provider groups"}</div>
        {item.groups.map((group: JsonRecord) => (
          <div className="sync-group-row" key={group.provider}>
            <strong>{group.provider}</strong>
            <span>{group.count} chat{group.count === 1 ? "" : "s"}</span>
          </div>
        ))}
        {!item.groups.length && <div className="file-empty">No chats need this sync task.</div>}
      </div>
      <div className="actions">
        <button className={item.tone === "danger" ? "danger" : "primary"} onClick={() => onRun(item)} disabled={!canRun} type="button">
          <Shield size={15} /> {item.actionLabel}
        </button>
      </div>
    </div>
  );
}

export { SyncDetail };
