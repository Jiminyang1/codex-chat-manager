import { ArchiveRestore, Trash2 } from "lucide-react";
import { formatDate, shortPath } from "../lib/format";
import {
  backupChatLocation,
  backupFilesSummary,
  backupKindLabel,
  backupScopeLabel,
  backupSubjectLabel,
  backupTitle,
  formatBackupDate
} from "../lib/backup-helpers";
import type { BackupScope, BackupSummary, Thread } from "../../../src/types";

function BackupDetail({ backup, activeProvider, onRestore, onDelete }: {
  backup: BackupSummary | null;
  activeProvider: string;
  onRestore: (scope: BackupScope) => void;
  onDelete: () => void;
}) {
  if (!backup) {
    return <div className="detail-empty"><ArchiveRestore size={28} /><p>Select a backup.</p></div>;
  }
  const fileNames = backupFilesSummary(backup.files);
  const primaryScope: BackupScope = backup.category === "chats"
    ? "chats"
    : backup.category === "sync"
      ? "metadata"
      : "config";
  const scopes = new Set(backup.scopes ?? [primaryScope]);
  const chats = backup.chatSummaries ?? [];
  const firstChat = chats[0] ?? null;
  return (
    <div className="detail backup-detail">
      <div className="detail-title">
        <h2>{backupTitle(backup)}</h2>
        <span className="badge">{backupKindLabel(backup)}</span>
      </div>
      <div className="kv">
        <span>Created</span><strong>{formatBackupDate(backup.createdAt)}</strong>
        <span>Kind</span><strong>{backupKindLabel(backup)}</strong>
        <span>Subject</span><strong>{backupSubjectLabel(backup)}</strong>
        <span>Chats</span><strong>{backup.threadIds?.length ?? 0}</strong>
        {backup.category === "chats" && firstChat && (
          <>
            <span>{backup.projectRoot ? "Sample chat" : "Location"}</span><strong>{backup.projectRoot ? firstChat.title || firstChat.id : backupChatLocation(firstChat, backup)}</strong>
            <span>Provider then</span><strong>{firstChat.model_provider || "-"}</strong>
            <span>Updated</span><strong>{formatDate(firstChat.updated_at)}</strong>
          </>
        )}
        {backup.category !== "chats" && (
          <>
            <span>Files</span><strong>{fileNames.length ? fileNames.join(", ") : "-"}</strong>
            <span>Path</span><strong>{shortPath(backup.path)}</strong>
          </>
        )}
      </div>

      <div className="backup-note">
        {backup.category === "chats" && `Chat restore brings deleted chats back and aligns them to the current active provider (${activeProvider || "-"}), so later provider sync state is preserved.`}
        {backup.category === "providers" && "Config restore writes only config.toml and auth.json. Chats, project state, and provider tags stay as they are."}
        {backup.category === "sync" && "Metadata restore rolls selected chat provider tags back to this snapshot. Use it when a sync/retag operation should be undone."}
      </div>

      {backup.category === "chats" && (
        <div className="backup-chat-list">
          <div className="sync-title">Chats in this backup</div>
          {chats.map((thread: Thread) => (
            <div className="backup-chat-row" key={thread.id}>
              <strong>{thread.title || "(untitled)"}</strong>
              <span>{backupChatLocation(thread, backup)} · {thread.model_provider || "-"} · {formatDate(thread.updated_at)}</span>
              <p>{thread.preview || thread.first_user_message || thread.id}</p>
            </div>
          ))}
          {!chats.length && <div className="file-empty">No chat summary in this backup.</div>}
        </div>
      )}

      <div className="backup-actions">
        {scopes.has(primaryScope) && (
          <button className="primary wide" onClick={() => onRestore(primaryScope)} type="button">
            <ArchiveRestore size={15} /> {backupScopeLabel(primaryScope)}
          </button>
        )}
        <button className="danger ghost wide" onClick={onDelete} type="button">
          <Trash2 size={15} /> Delete backup
        </button>
      </div>

      {backup.category !== "chats" && (
        <section className="file-disclosure">
          <div className="file-toggle static">
            <ArchiveRestore size={14} />
            <span>metadata</span>
            <strong>{backup.reason || backup.name}</strong>
          </div>
          <pre className="file-preview compact-preview">{JSON.stringify({
            reason: backup.reason,
            scopes: backup.scopes,
            files: backup.files,
            threadIds: backup.threadIds
          }, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

export { BackupDetail };
