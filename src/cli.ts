#!/usr/bin/env node

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
import { normalizeCommand, parseArgs, usage } from "./cli/commands.js";
import { COLOR, color, compactPath, printKeyValues, shellQuote, shortId } from "./cli/format.js";
import {
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
} from "./cli/printers.js";

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
    const scope = flags.scope === "chats" || flags.scope === "config" || flags.scope === "metadata"
      ? flags.scope
      : undefined;
    const result = await restoreBackup(home, backupDir, execute, scope);
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
    const file = flags.file === "auth" ? "auth" : "config";
    const data = await readConfigFile(home, file);
    printJson(data);
    return;
  }

  if (command === "config-file-write") {
    const file = flags.file === "auth" ? "auth" : "config";
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
