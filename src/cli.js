#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import {
  codexHome,
  deleteProfile,
  deleteProject,
  fixReservedProviders,
  getConfigOverview,
  getProjects,
  getStatus,
  isTruthy,
  listBackups,
  parseLimit,
  parsePort,
  readConfigFile,
  readThreadByRef,
  readThreads,
  resolveBackupRef,
  resolveProjectRef,
  restoreBackup,
  saveProfile,
  switchProfile,
  syncProviderTag,
  trashThreads,
  writeConfigFile
} from "./core/index.js";

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

function shouldColor() {
  return process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR);
}

function color(code, value) {
  return shouldColor() ? `${code}${value}${COLOR.reset}` : String(value);
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function usage() {
  console.log(`${color(COLOR.bold, "codex-chat-manager")}

${color(COLOR.cyan, "Quick start")}
  codex-chat-manager status
  codex-chat-manager chats --limit 20
  codex-chat-manager projects
  codex-chat-manager backups
  codex-chat-manager web

${color(COLOR.cyan, "Delete, safely")}
  codex-chat-manager delete-chat <chat-id-or-prefix>
  codex-chat-manager delete-chat <chat-id-or-prefix> --yes
  codex-chat-manager delete-project '<path-or-#number>'
  codex-chat-manager delete-project '<path-or-#number>' --yes

${color(COLOR.cyan, "Commands")}
  status
  projects | ps
  list | chats | ls [--project PATH] [--provider ID] [--archived] [--all] [--limit N]
  delete-chat | trash-thread | rm-chat <chat-id-or-prefix>
  delete-project | rm-project '<path-or-#number>'
  trash-provider | delete-provider <provider-id>
  backups
  restore <backup-dir-or-#number> [--scope chats|config|metadata]
  web [--port 8765]

${color(COLOR.cyan, "Config / provider switching")}
  config | cfg
  profile-switch | switch <profile-id>
  config-save-profile <label> [--note TEXT]
  config-delete-profile <profile-id>
  config-sync | sync [--mode repair|retag] [--to <provider-id>]
                                 Repair SQLite/rollout mismatches or retag chats to the active provider
  config-fix | fix-reserved [--to <id>]     Rename a reserved [model_providers.openai] block to a custom id

${color(COLOR.cyan, "Options")}
  --codex-home PATH   Use another Codex home, default ~/.codex
  --json              Print machine-readable JSON
  --yes               Execute a mutation; without it, mutations are previews
  --no-color          Disable ANSI color
`);
}

function normalizeCommand(command) {
  const aliases = {
    chat: "list",
    chats: "list",
    ls: "list",
    ps: "projects",
    backup: "backups",
    delete: "trash-thread",
    "delete-chat": "trash-thread",
    "rm-chat": "trash-thread",
    "rm-thread": "trash-thread",
    "delete-provider": "trash-provider",
    "rm-provider": "trash-provider",
    "rm-project": "delete-project",
    serve: "web",
    ui: "web",
    config: "config-show",
    cfg: "config-show",
    switch: "profile-switch",
    "save-profile": "config-save-profile",
    "delete-profile": "config-delete-profile",
    sync: "config-sync",
    "sync-provider": "config-sync",
    "fix-reserved": "config-fix",
    "fix-provider": "config-fix"
  };
  return aliases[command] ?? command;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function compactPath(value) {
  if (!value) return "";
  const home = os.homedir();
  return String(value).replace(home, "~");
}

function shortId(value, length = 18) {
  if (!value) return "";
  return String(value).slice(0, length);
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatDateObject(date) {
  if (Number.isNaN(date.getTime())) return "-";
  return [
    date.getFullYear(),
    "-",
    twoDigits(date.getMonth() + 1),
    "-",
    twoDigits(date.getDate()),
    " ",
    twoDigits(date.getHours()),
    ":",
    twoDigits(date.getMinutes())
  ].join("");
}

function formatDate(seconds) {
  if (!seconds) return "-";
  return formatDateObject(new Date(seconds * 1000));
}

function formatIsoDate(value) {
  if (!value) return "-";
  return formatDateObject(new Date(value));
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (stripAnsi(text).length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, Math.max(0, width - 1))}.`;
}

function pad(value, width, align = "left") {
  const text = String(value ?? "");
  const size = stripAnsi(text).length;
  if (size >= width) return text;
  const spaces = " ".repeat(width - size);
  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

function printTitle(title) {
  console.log(color(COLOR.bold, title));
  console.log(color(COLOR.gray, "-".repeat(Math.max(16, stripAnsi(title).length))));
}

function printKeyValues(rows) {
  const width = Math.max(...rows.map(([key]) => stripAnsi(key).length), 0);
  for (const [key, value] of rows) {
    console.log(`${color(COLOR.gray, pad(key, width))}  ${value}`);
  }
}

function printTable(columns, rows, { empty = "No rows." } = {}) {
  if (!rows.length) {
    console.log(color(COLOR.gray, empty));
    return;
  }
  const widths = columns.map((column) => {
    const values = rows.map((row) => truncate(row[column.key], column.width ?? 30));
    const max = Math.max(stripAnsi(column.label).length, ...values.map((value) => stripAnsi(value).length));
    return Math.min(column.width ?? max, Math.max(max, column.min ?? 0));
  });
  console.log(columns.map((column, index) => color(COLOR.bold, pad(truncate(column.label, widths[index]), widths[index], column.align))).join("  "));
  console.log(columns.map((_, index) => color(COLOR.gray, "-".repeat(widths[index]))).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => pad(truncate(row[column.key], widths[index]), widths[index], column.align)).join("  "));
  }
}

function printNext(command) {
  console.log("");
  console.log(`${color(COLOR.gray, "Next")}  ${command}`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.split("=", 2);
    const name = rawName.slice(2);
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

function printConfigSyncResult(result, execute) {
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

function printConfigOverview(overview) {
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
    ], overview.profiles.map((profile, i) => ({
      index: `#${i + 1}`,
      label: profile.label,
      kind: profile.kind,
      hasAuth: profile.hasAuth ? "yes" : "",
      active: profile.active ? "yes" : ""
    })));
    printNext("codex-chat-manager profile-switch '#1'");
  }
}

function printProfileSwitchResult(result, execute) {
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

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status) {
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

function providerSummaryRows(status) {
  const byProvider = new Map();
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

function printProjects(projects) {
  printTitle("Projects");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "chats", label: "Chats", align: "right" },
    { key: "active", label: "Active", align: "right" },
    { key: "archived", label: "Arch", align: "right" },
    { key: "kind", label: "Kind", width: 10 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "path", label: "Project", width: 58 }
  ], projects.map((project, index) => ({
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

function threadTableRows(threads) {
  return threads.map((thread) => ({
    ref: shortId(thread.id),
    state: thread.archived ? "archived" : "active",
    provider: thread.model_provider,
    updated: formatDate(thread.updated_at),
    project: compactPath(thread.cwd),
    title: thread.title || "(untitled)"
  }));
}

function printThreadTable(threads, { empty = "No chats match the current filters." } = {}) {
  printTable([
    { key: "ref", label: "Ref", width: 18 },
    { key: "state", label: "State", width: 8 },
    { key: "provider", label: "Provider", width: 16 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "project", label: "Project", width: 34 },
    { key: "title", label: "Title", width: 34 }
  ], threadTableRows(threads), { empty });
}

function printThreads(threads, limit) {
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

function printBackups(backups) {
  printTitle("Backups");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "created", label: "Created", width: 16 },
    { key: "category", label: "Category", width: 10 },
    { key: "threads", label: "Chats", align: "right" },
    { key: "title", label: "Title", width: 24 },
    { key: "subject", label: "Subject", width: 28 },
    { key: "path", label: "Backup", width: 56 }
  ], backups.map((backup, index) => ({
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

function printMutationResult({ title, result, execute, previewCommand, executeCommand, emptyMessage }) {
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

function printRestoreResult(result, execute) {
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

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (isTruthy(flags["no-color"])) {
    process.env.NO_COLOR = "1";
  }
  const command = normalizeCommand(positionals[0]);
  if (!command || command === "help" || isTruthy(flags.help)) {
    usage();
    return;
  }

  const home = codexHome(flags);
  const asJson = isTruthy(flags.json);
  const execute = isTruthy(flags.yes);

  if (command === "web") {
    const { startServer } = await import("./server.js");
    startServer({ port: parsePort(flags.port, 8765) });
    return;
  }

  if (command === "status") {
    const status = await getStatus(home);
    asJson ? printJson(status) : printStatus(status);
    return;
  }

  if (command === "projects") {
    const projects = await getProjects(home);
    asJson ? printJson(projects) : printProjects(projects);
    return;
  }

  if (command === "list") {
    const limit = parseLimit(flags.limit, 50);
    const threads = readThreads(home, flags);
    asJson ? printJson(threads) : printThreads(threads, limit);
    return;
  }

  if (command === "backups") {
    const backups = await listBackups(home);
    asJson ? printJson(backups) : printBackups(backups);
    return;
  }

  if (command === "trash-thread") {
    const id = positionals[1];
    if (!id) throw new Error("delete-chat requires a chat id or unique id prefix");
    const thread = readThreadByRef(home, id);
    if (!thread) throw new Error(`Chat not found: ${id}`);
    const result = await trashThreads(home, [thread], { execute, reason: `trash-thread:${id}` });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Chat" : "Delete Chat Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-chat ${shortId(thread.id)}`,
      executeCommand: `codex-chat-manager delete-chat ${shortId(thread.id)} --yes`
    });
    return;
  }

  if (command === "trash-provider") {
    const provider = positionals[1] ?? flags.provider;
    if (!provider) throw new Error("trash-provider requires a provider id");
    const threads = readThreads(home, { all: true, provider });
    const result = await trashThreads(home, threads, { execute, reason: `trash-provider:${provider}` });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Provider Chats" : "Delete Provider Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-provider ${shellQuote(provider)}`,
      executeCommand: `codex-chat-manager delete-provider ${shellQuote(provider)} --yes`,
      emptyMessage: "No chats found for this provider."
    });
    return;
  }

  if (command === "delete-project" || command === "remove-project") {
    const project = await resolveProjectRef(home, positionals[1] ?? flags.project);
    if (!project) throw new Error(`${command} requires a project path`);
    const result = await deleteProject(home, project, { execute });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Project" : "Delete Project Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-project ${shellQuote(result.project)}`,
      executeCommand: `codex-chat-manager delete-project ${shellQuote(result.project)} --yes`,
      emptyMessage: "No matching project roots or chats found."
    });
    return;
  }

  if (command === "restore") {
    const backupDir = await resolveBackupRef(home, positionals[1] ?? flags.backup);
    if (!backupDir) throw new Error("restore requires a backup directory");
    const result = await restoreBackup(home, backupDir, execute, flags.scope);
    asJson ? printJson(result) : printRestoreResult(result, execute);
    return;
  }

  if (command === "config-show") {
    const overview = await getConfigOverview(home);
    asJson ? printJson(overview) : printConfigOverview(overview);
    return;
  }

  if (command === "profile-switch") {
    const profileId = positionals[1] ?? flags.profile ?? flags.id;
    if (!profileId) throw new Error("profile-switch requires a profile id");
    const result = await switchProfile(home, profileId, { execute });
    asJson ? printJson(result) : printProfileSwitchResult(result, execute);
    return;
  }

  if (command === "config-file") {
    const data = await readConfigFile(home, typeof flags.file === "string" ? flags.file : "config");
    printJson(data);
    return;
  }

  if (command === "config-file-write") {
    const file = typeof flags.file === "string" ? flags.file : "config";
    const b64 = flags["content-b64"];
    if (typeof b64 !== "string") throw new Error("config-file-write requires --content-b64");
    const content = Buffer.from(b64, "base64").toString("utf8");
    const result = await writeConfigFile(home, file, content, { execute });
    asJson ? printJson(result) : printKeyValues([
      [result.dryRun ? "Would write" : "Wrote", result.path],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "n/a"]
    ]);
    return;
  }

  if (command === "config-fix") {
    const result = await fixReservedProviders(home, {
      toId: typeof flags.to === "string" ? flags.to : "openai-custom",
      execute
    });
    asJson ? printJson(result) : (result.noOp
      ? console.log("No reserved built-in provider blocks found; nothing to fix.")
      : printKeyValues([
          ["Mode", execute ? "Fixed" : color(COLOR.yellow, "preview")],
          ["Renamed to", result.toId],
          ["Backup", result.backupDir ? compactPath(result.backupDir) : "n/a"]
        ]));
    return;
  }

  if (command === "config-sync") {
    const result = await syncProviderTag(home, {
      toId: typeof flags.to === "string" ? flags.to : undefined,
      mode: isTruthy(flags.repair) || flags.mode === "repair" ? "repair" : "retag",
      execute
    });
    asJson ? printJson(result) : printConfigSyncResult(result, execute);
    return;
  }

  if (command === "config-save-profile") {
    const label = positionals[1] ?? flags.label;
    if (!label) throw new Error("config-save-profile requires a label");
    const result = await saveProfile(home, {
      label,
      note: typeof flags.note === "string" ? flags.note : "",
      kind: typeof flags.kind === "string" ? flags.kind : undefined
    });
    asJson ? printJson(result) : printKeyValues([["Saved profile", result.profile.label], ["Id", result.profile.id]]);
    return;
  }

  if (command === "config-delete-profile") {
    const id = positionals[1] ?? flags.id;
    if (!id) throw new Error("config-delete-profile requires a profile id");
    const result = await deleteProfile(home, id, { execute });
    asJson ? printJson(result) : printKeyValues([
      [result.dryRun ? "Would delete" : "Deleted", result.profile.label],
      ["Id", result.profile.id]
    ]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
