import {
  COLOR,
  color,
  compactPath,
  formatDate,
  formatIsoDate,
  printKeyValues,
  printNext,
  printTable,
  printTitle,
  shellQuote,
  shortId
} from "./format.js";
import type { BackupSummary, ConfigOverview, JsonRecord, Project, Status, Thread } from "../types.js";

type MutationPrintOptions = {
  title: string;
  result: JsonRecord;
  execute: boolean;
  previewCommand?: string;
  executeCommand: string;
  emptyMessage?: string;
};

function printConfigSyncResult(result: JsonRecord, execute: boolean): void {
  printTitle(execute ? "Synced Chat Providers" : "Sync Preview");
  const isRepair = result.mode === "repair";
  if (execute) {
    if (result.noOp) {
      console.log(isRepair
        ? "Nothing to repair; SQLite and rollout provider metadata already match."
        : `Nothing to sync; all chats already use "${result.target}".`);
      return;
    }
    printKeyValues([
      ["Sync mode", isRepair ? "repair mismatches" : "retag to current"],
      ["Target provider", result.target ?? "-"],
      [isRepair ? "Chats repaired" : "Chats retagged", color(COLOR.green, result.updated)],
      ["SQLite rows", result.dbUpdated ?? result.updated],
      ["Rollouts", result.rolloutUpdated ?? 0],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "none"]
    ]);
    if (result.backupDir) printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Sync mode", isRepair ? "repair mismatches" : "retag to current"],
    ["Target provider", result.target ?? "-"],
    [isRepair ? "Chats to repair" : "Chats to retag", result.total]
  ]);
  if (result.groups?.length) {
    console.log("");
    printTable([
      { key: "provider", label: "From provider", width: 24 },
      { key: "count", label: "Chats", align: "right" }
    ], result.groups);
  }
  printNext(`codex-chat-manager config-sync${isRepair ? " --mode repair" : ""} --yes`);
}

function printConfigOverview(overview: ConfigOverview): void {
  printTitle("Codex Config");
  printKeyValues([
    ["Codex home", compactPath(overview.codexHome)],
    ["Active", overview.kind === "official"
      ? color(COLOR.green, "official")
      : overview.kind === "third-party"
        ? color(COLOR.yellow, "third-party")
        : color(COLOR.gray, overview.kind)],
    ["Model", overview.model ?? "-"],
    ["Provider", overview.modelProvider ?? "-"],
    ["Base URL", overview.provider?.baseUrl ?? "-"],
    ["Wire API", overview.provider?.wireApi ?? "-"],
    ["Requires OpenAI auth", String(overview.provider?.requiresOpenaiAuth ?? "-")],
    ["Bearer token", overview.bearer.present ? overview.bearer.masked : "none"],
    ["Auth mode", overview.auth.mode ?? "-"]
  ]);
  if (overview.profiles.length) {
    console.log("");
    printTitle("Profiles");
    printTable([
      { key: "index", label: "#", align: "right", width: 3 },
      { key: "label", label: "Name", width: 22 },
      { key: "kind", label: "Kind", width: 12 },
      { key: "hasAuth", label: "Auth", width: 5 },
      { key: "active", label: "Active", width: 7 }
    ], overview.profiles.map((profile, i: number) => ({
      index: `#${i + 1}`,
      label: profile.label,
      kind: profile.kind,
      hasAuth: profile.hasAuth ? "yes" : "",
      active: profile.active ? "yes" : ""
    })));
    printNext("codex-chat-manager profile-switch '#1'");
  }
}

function printProfileSwitchResult(result: JsonRecord, execute: boolean): void {
  printTitle(execute ? "Profile Switched" : "Switch Preview");
  if (execute) {
    printKeyValues([
      ["Profile", result.profile.label],
      ["Wrote config.toml", result.wroteConfig ? color(COLOR.green, "yes") : "no"],
      ["Wrote auth.json", result.wroteAuth ? color(COLOR.green, "yes") : "skipped (no auth snapshot)"]
    ]);
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Profile", `${result.profile.label} (${result.profile.kind})`],
    ["Writes config.toml", "yes"],
    ["Writes auth.json", result.willWriteAuth ? "yes" : "skipped (no auth snapshot)"]
  ]);
  console.log("");
  printNext(`codex-chat-manager profile-switch ${shellQuote(result.profile.id)} --yes`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status: Status): void {
  const mismatchCount = (status.missingRolloutCount ?? 0) + (status.missingDbCount ?? 0) + (status.rolloutPathOutsideHomeCount ?? 0);
  printTitle("Codex Chat Manager Status");
  printKeyValues([
    ["Codex home", compactPath(status.codexHome)],
    ["SQLite", status.integrity === "ok" ? color(COLOR.green, "ok") : color(COLOR.red, status.integrity)],
    ["Chats", `${status.totals.threads ?? 0} total, ${status.totals.active ?? 0} active, ${status.totals.archived ?? 0} archived`],
    ["Interactive", status.totals.interactive ?? 0],
    ["Rollout files", status.rolloutFiles],
    ["Mismatches", mismatchCount === 0 ? color(COLOR.green, "0") : color(COLOR.yellow, mismatchCount)]
  ]);

  if (mismatchCount) {
    console.log("");
    printKeyValues([
      ["Missing rollouts", status.missingRolloutCount ?? 0],
      ["Rollouts missing DB", status.missingDbCount ?? 0],
      ["Paths outside home", status.rolloutPathOutsideHomeCount ?? 0]
    ]);
  }

  console.log("");
  printTitle("Providers");
  printTable([
    { key: "provider", label: "Provider", width: 24 },
    { key: "active", label: "Active", align: "right" },
    { key: "archived", label: "Archived", align: "right" },
    { key: "total", label: "Total", align: "right" },
    { key: "rollouts", label: "Files", align: "right" }
  ], providerSummaryRows(status), { empty: "No providers found." });
}

function providerSummaryRows(status: Status): JsonRecord[] {
  const byProvider = new Map<string, JsonRecord>();
  for (const row of status.sqliteProviders ?? []) {
    const item = byProvider.get(row.model_provider) ?? { provider: row.model_provider, active: 0, archived: 0, total: 0, rollouts: 0 };
    if (Number(row.archived)) item.archived += Number(row.count) || 0;
    else item.active += Number(row.count) || 0;
    item.total += Number(row.count) || 0;
    byProvider.set(row.model_provider, item);
  }
  for (const [provider, count] of Object.entries(status.rolloutProviders ?? {})) {
    const item = byProvider.get(provider) ?? { provider, active: 0, archived: 0, total: 0, rollouts: 0 };
    item.rollouts = count;
    byProvider.set(provider, item);
  }
  return [...byProvider.values()].sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider));
}

function printProjects(projects: Project[]): void {
  printTitle("Projects");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "chats", label: "Chats", align: "right" },
    { key: "active", label: "Active", align: "right" },
    { key: "archived", label: "Arch", align: "right" },
    { key: "kind", label: "Kind", width: 10 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "path", label: "Project", width: 58 }
  ], projects.map((project, index: number) => ({
    index: `#${index + 1}`,
    chats: project.total,
    active: project.active,
    archived: project.archived,
    kind: project.saved ? "saved" : "discovered",
    updated: formatDate(project.updated_at),
    path: compactPath(project.path)
  })), { empty: "No projects found." });
  if (projects.length) {
    printNext("codex-chat-manager delete-project '#1'");
  }
}

function threadTableRows(threads: Thread[]): JsonRecord[] {
  return threads.map((thread) => ({
    ref: shortId(thread.id),
    state: thread.archived ? "archived" : "active",
    provider: thread.model_provider,
    updated: formatDate(thread.updated_at),
    project: compactPath(thread.cwd),
    title: thread.title || "(untitled)"
  }));
}

function printThreadTable(threads: Thread[], { empty = "No chats match the current filters." }: { empty?: string } = {}): void {
  printTable([
    { key: "ref", label: "Ref", width: 18 },
    { key: "state", label: "State", width: 8 },
    { key: "provider", label: "Provider", width: 16 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "project", label: "Project", width: 34 },
    { key: "title", label: "Title", width: 34 }
  ], threadTableRows(threads), { empty });
}

function printThreads(threads: Thread[], limit: number): void {
  const visible = threads.slice(0, limit);
  printTitle("Chats");
  printThreadTable(visible);
  if (threads.length > visible.length) {
    console.log("");
    console.log(color(COLOR.gray, `${threads.length - visible.length} more hidden by --limit. Increase --limit to show more.`));
  }
  if (visible.length) {
    printNext(`codex-chat-manager delete-chat ${shortId(visible[0].id)}`);
  }
}

function printBackups(backups: BackupSummary[]): void {
  printTitle("Backups");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "created", label: "Created", width: 16 },
    { key: "category", label: "Category", width: 10 },
    { key: "threads", label: "Chats", align: "right" },
    { key: "title", label: "Title", width: 24 },
    { key: "subject", label: "Subject", width: 28 },
    { key: "path", label: "Backup", width: 56 }
  ], backups.map((backup, index: number) => ({
    index: `#${index + 1}`,
    created: formatIsoDate(backup.createdAt),
    category: backup.category ?? "-",
    threads: backup.threadIds.length,
    title: backup.title || backup.reason || "backup",
    subject: backup.subject || backup.reason || "backup",
    path: compactPath(backup.path)
  })), { empty: "No chat-manager backups found." });
  if (backups.length) {
    printNext("codex-chat-manager restore '#1' --yes");
  }
}

function printMutationResult({ title, result, execute, previewCommand, executeCommand, emptyMessage }: MutationPrintOptions): void {
  printTitle(title);
  if (execute) {
    if (result.noOp) {
      console.log(emptyMessage ?? "Nothing changed.");
      return;
    }
    printKeyValues([
      ["Changed", color(COLOR.green, "yes")],
      ["Chats", result.trashed ?? 0],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "none"]
    ]);
    if (result.backupDir) {
      printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
    }
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Chats", result.matchingThreadCount ?? result.threads?.length ?? 0],
    ["Backup", "will be created on --yes"]
  ]);
  if (result.project) {
    printKeyValues([["Project", compactPath(result.project)]]);
  }
  if (result.threads?.length || result.matchingThreads?.length) {
    const threads = result.threads ?? result.matchingThreads;
    console.log("");
    printTitle("Affected Chats");
    printThreadTable(threads.slice(0, 10), { empty: "No chats will be changed." });
    if (threads.length > 10) {
      console.log(color(COLOR.gray, `${threads.length - 10} more chats will also be changed.`));
    }
  }
  if (previewCommand) {
    console.log("");
    console.log(color(COLOR.gray, `Preview command: ${previewCommand}`));
  }
  printNext(executeCommand);
}

function printRestoreResult(result: JsonRecord, execute: boolean): void {
  printTitle(execute ? "Restored Backup" : "Restore Preview");
  if (execute) {
    printKeyValues([
      ["Backup", compactPath(result.backupDir)],
      ["Scope", result.scope],
      ["Pre-restore backup", compactPath(result.preRestoreBackup)],
      ["Restored files", result.restoredFiles],
      ["Provider aligned", result.alignedProvider?.target ?? "n/a"]
    ]);
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Backup", compactPath(result.backupDir)],
    ["Scope", result.scope],
    ["Reason", result.metadata?.reason ?? "backup"],
    ["Category", result.backup?.category ?? "-"],
    ["Chats", result.metadata?.threadIds?.length ?? 0],
    ["Created", formatIsoDate(result.metadata?.createdAt)]
  ]);
  printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --scope ${result.scope} --yes`);
}

export {
  printBackups,
  printConfigOverview,
  printConfigSyncResult,
  printJson,
  printMutationResult,
  printProfileSwitchResult,
  printProjects,
  printRestoreResult,
  printStatus,
  printThreads
};
