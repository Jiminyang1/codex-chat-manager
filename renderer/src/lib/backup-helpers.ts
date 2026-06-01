import { formatDate, projectName, shortPath } from "./format";
import type { BackupFiles, BackupScope, BackupSummary, JsonRecord, Thread } from "../../../src/types";

function formatBackupDate(value: unknown): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(String(value)));
}

function backupFilesSummary(files: Partial<BackupFiles> | undefined): string[] {
  const names: string[] = [];
  if (files?.db) names.push("SQLite");
  if (files?.config) names.push("config.toml");
  if (files?.auth) names.push("auth.json");
  if (files?.globalState) names.push("global state");
  if (files?.trashManifest) names.push("trash");
  return names;
}

function backupScopeLabel(scope: BackupScope | string): string {
  if (scope === "chats") return "Restore chats";
  if (scope === "config") return "Restore config/auth";
  if (scope === "metadata") return "Restore metadata";
  return "Restore";
}

function backupRestoreMessage(backup: BackupSummary | null | undefined, scope: BackupScope, activeProvider: string): string {
  const created = formatBackupDate(backup?.createdAt);
  const count = backup?.threadIds?.length ?? 0;
  if (scope === "chats") {
    return [
      `${backup?.title || "Backup"} · ${created}`,
      "",
      `Restore ${count} chat(s), rollout files, and chat sidebar references from this backup.`,
      "",
      `Restored chats will be aligned to the current active provider: ${activeProvider || "-"}. This keeps a later provider sync/retag in place.`
    ].join("\n");
  }
  if (scope === "config") {
    return [
      `${backup?.title || "Backup"} · ${created}`,
      "",
      "Restore config.toml and auth.json from this backup.",
      "",
      "SQLite chats, project state, and provider metadata are left unchanged."
    ].join("\n");
  }
  if (scope === "metadata") {
    return [
      `${backup?.title || "Backup"} · ${created}`,
      "",
      `Restore provider metadata for ${count} chat(s) from this backup.`,
      "",
      "This can undo a later provider sync/retag. config.toml and auth.json are left unchanged."
    ].join("\n");
  }
  return `${backup?.title || "Backup"} · ${created}`;
}

function backupBulkDeleteMessage(backups: BackupSummary[]): string {
  const counts = backups.reduce((acc, backup) => {
    const category = backup.category === "chats" || backup.category === "providers" || backup.category === "sync" ? backup.category : "providers";
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const scopeLine = [
    counts.chats ? `${counts.chats} chat/project` : "",
    counts.providers ? `${counts.providers} config` : "",
    counts.sync ? `${counts.sync} sync` : ""
  ].filter(Boolean).join(", ");
  const preview = backups.slice(0, 6).map((backup) => `- ${backupTitle(backup)} · ${formatBackupDate(backup.createdAt)}`);
  if (backups.length > preview.length) {
    preview.push(`- ${backups.length - preview.length} more`);
  }
  return [
    `Delete ${backups.length} selected backup snapshot${backups.length === 1 ? "" : "s"}${scopeLine ? ` (${scopeLine})` : ""}.`,
    "",
    "This permanently removes the selected snapshots. Restoring from them will no longer be possible.",
    "",
    ...preview
  ].join("\n");
}

function backupTitle(backup: BackupSummary | null | undefined): string {
  if (backup?.category === "chats") {
    const chats = backup.chatSummaries ?? [];
    if (backup.kind === "chat" && chats[0]) return chats[0].title || "(untitled)";
    if (backup.kind === "project" && backup.projectRoot) return projectName(backup.projectRoot);
    if (backup.kind === "project" && chats[0]) return chats[0].title || `${chats.length || backup.threadIds?.length || 0} chat(s)`;
    return `${chats.length || backup.threadIds?.length || 0} chat(s)`;
  }
  return backup?.title || backup?.reason || "Backup";
}

function backupKindLabel(backup: BackupSummary | null | undefined): string {
  if (!backup) return "backup";
  if (backup.category === "chats") {
    if (backup.kind === "project") return backup.projectRoot ? "project" : ((backup.threadIds?.length ?? 0) > 1 ? "chats" : "chat");
    if (backup.kind === "chat") return "chat";
    return "chats";
  }
  if (backup.category === "providers") return "config";
  if (backup.category === "sync") return "metadata";
  return backup.kind || backup.category || "backup";
}

function backupProjectPath(backup: BackupSummary | null | undefined): string {
  if (backup?.category !== "chats") return "";
  if (backup.projectRoot) return backup.projectRoot;
  const first = backup.chatSummaries?.[0];
  if (first?.projectless) return "";
  return first?.savedProjectRoot || "";
}

function backupProjectLabel(projectPath: string): string {
  return projectPath ? projectName(projectPath) : "Projectless chats";
}

function backupGroupMeta(group: JsonRecord): string {
  const project = group.projectPath ? shortPath(group.projectPath) : "No saved project path";
  const snapshotCount = group.backups.length;
  const chatCount = group.chatCount;
  return `${project} · ${snapshotCount} backup${snapshotCount === 1 ? "" : "s"} · ${chatCount} chat${chatCount === 1 ? "" : "s"}`;
}

function backupSubjectLabel(backup: BackupSummary | null | undefined): string {
  if (!backup) return "-";
  const chats = backup.chatSummaries ?? [];
  const first = chats[0];
  if (backup.category === "chats") {
    if (backup.projectRoot) return shortPath(backup.projectRoot);
    if (backup.kind === "project") return "Projectless chats";
    if (backup.kind === "chat" && first) return first.title || first.id;
    return backup.subject || first?.title || first?.id || "-";
  }
  return backup.subject || backup.reason || "-";
}

function backupRowTitle(backup: BackupSummary): string {
  if (backup?.category === "chats" && backup.kind === "project" && backup.projectRoot) return "Project snapshot";
  return backupTitle(backup);
}

function backupRowSubtitle(backup: BackupSummary): string {
  if (backup?.category === "chats") {
    const chats = backup.chatSummaries ?? [];
    const first = chats[0];
    const count = chats.length || backup.threadIds?.length || 0;
    if (first) {
      const more = count > 1 ? ` + ${count - 1} more` : "";
      return `${first.model_provider || "-"} · ${formatDate(first.updated_at)}${more}`;
    }
    return `${count} chat(s) · ${formatBackupDate(backup.createdAt)}`;
  }
  return backupSubtitle(backup);
}

function backupChatLocation(thread: Thread, backup: BackupSummary | null | undefined): string {
  if (backup?.projectRoot) return projectName(backup.projectRoot);
  if (thread?.projectless || !thread?.savedProjectRoot) return "Projectless";
  return projectName(thread.savedProjectRoot);
}

function backupSubtitle(backup: BackupSummary | null | undefined): string {
  if (backup?.category === "chats") {
    const chats = backup.chatSummaries ?? [];
    const first = chats[0];
    const count = chats.length || backup.threadIds?.length || 0;
    if (first) {
      const more = count > 1 ? ` + ${count - 1} more` : "";
      return `${projectName(first.cwd)} · ${first.model_provider || "-"} · ${formatDate(first.updated_at)}${more}`;
    }
    return `${count} chat(s) · ${formatBackupDate(backup.createdAt)}`;
  }
  return `${backup?.subject || backup?.reason || "snapshot"} · ${backup?.threadIds?.length ?? 0} chats · ${formatBackupDate(backup?.createdAt)}`;
}

export {
  backupChatLocation,
  backupBulkDeleteMessage,
  backupFilesSummary,
  backupGroupMeta,
  backupKindLabel,
  backupProjectLabel,
  backupProjectPath,
  backupRestoreMessage,
  backupRowSubtitle,
  backupRowTitle,
  backupScopeLabel,
  backupSubjectLabel,
  backupSubtitle,
  backupTitle,
  formatBackupDate
};
