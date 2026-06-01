import type { Status } from "../../../src/types";

function StatusPanel({ status }: { status: Status | null }) {
  return <div className="detail"><h2>Status</h2><div className="kv"><span>Codex home</span><strong>{status?.codexHome ?? "-"}</strong><span>SQLite</span><strong>{status?.integrity ?? "-"}</strong><span>Rollouts</span><strong>{status?.rolloutFiles ?? 0}</strong></div></div>;
}

export { StatusPanel };
