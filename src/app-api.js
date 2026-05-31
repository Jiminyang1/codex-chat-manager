import os from "node:os";
import path from "node:path";
import { isCodexDesktopRunning, quitCodexDesktop } from "./codex-process.js";
import {
  createProvider,
  deleteProfile,
  deleteProject,
  fixReservedProviders,
  getConfigOverview,
  getOfficialProviderFiles,
  getProjects,
  getProjectlessThreads,
  getStatus,
  listBackups,
  readConfigFile,
  readProfileFile,
  readThreadByRef,
  readThreads,
  restoreBackup,
  saveProfile,
  switchProfile,
  syncProviderTag,
  trashThreads,
  useOfficialProvider,
  writeConfigFile,
  writeProfileFile
} from "./core/index.js";

export const defaultCodexHome = path.join(os.homedir(), ".codex");

export const allowedActions = new Set([
  "status:get",
  "projects:list",
  "projectlessThreads:list",
  "threads:list",
  "backups:list",
  "codex:processStatus",
  "codex:quit",
  "thread:trash",
  "project:delete",
  "backup:restore",
  "config:get",
  "config:file:get",
  "config:file:write",
  "config:fix",
  "config:sync",
  "profile:switch",
  "profile:save",
  "profile:delete",
  "profile:file:get",
  "profile:file:write",
  "provider:create",
  "provider:officialFiles",
  "provider:useOfficial"
]);

export function safeCodexHome(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultCodexHome;
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

function executeFromPayload(payload) {
  return payload?.confirmed === true;
}

export async function invokeAction(action, payload = {}) {
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  const home = safeCodexHome(payload.codexHome);

  switch (action) {
    case "status:get":
      return getStatus(home);
    case "projects:list":
      return getProjects(home);
    case "projectlessThreads:list":
      return getProjectlessThreads(home, {
        provider: payload.provider,
        archived: payload.archived
      });
    case "threads:list":
      return readThreads(home, {
        all: true,
        ids: Array.isArray(payload.ids) ? payload.ids : undefined,
        project: payload.project,
        provider: payload.provider,
        archived: payload.archived
      });
    case "backups:list":
      return listBackups(home);
    case "codex:processStatus":
      return isCodexDesktopRunning();
    case "codex:quit":
      return quitCodexDesktop();
    case "thread:trash": {
      if (!payload.threadId) throw new Error("threadId is required");
      const thread = readThreadByRef(home, payload.threadId);
      if (!thread) throw new Error(`Chat not found: ${payload.threadId}`);
      return trashThreads(home, [thread], {
        execute: executeFromPayload(payload),
        reason: `trash-thread:${payload.threadId}`
      });
    }
    case "project:delete": {
      if (!payload.project) throw new Error("project is required");
      return deleteProject(home, payload.project, { execute: executeFromPayload(payload) });
    }
    case "backup:restore": {
      if (!payload.backupDir) throw new Error("backupDir is required");
      return restoreBackup(home, payload.backupDir, executeFromPayload(payload));
    }
    case "config:get":
      return getConfigOverview(home);
    case "config:file:get":
      return readConfigFile(home, payload.file === "auth" ? "auth" : "config");
    case "config:file:write":
      if (typeof payload.content !== "string") throw new Error("content is required");
      return writeConfigFile(home, payload.file === "auth" ? "auth" : "config", payload.content, {
        execute: executeFromPayload(payload)
      });
    case "config:fix":
      return fixReservedProviders(home, {
        toId: typeof payload.to === "string" && payload.to ? payload.to : "openai-custom",
        execute: executeFromPayload(payload)
      });
    case "config:sync":
      return syncProviderTag(home, {
        toId: typeof payload.to === "string" && payload.to ? payload.to : undefined,
        execute: executeFromPayload(payload)
      });
    case "profile:switch":
      if (!payload.profileId) throw new Error("profileId is required");
      return switchProfile(home, payload.profileId, { execute: executeFromPayload(payload) });
    case "profile:save":
      if (!payload.label) throw new Error("label is required");
      return saveProfile(home, {
        label: String(payload.label),
        note: typeof payload.note === "string" ? payload.note : "",
        kind: typeof payload.kind === "string" ? payload.kind : undefined
      });
    case "profile:delete":
      if (!payload.id) throw new Error("id is required");
      return deleteProfile(home, payload.id, { execute: executeFromPayload(payload) });
    case "profile:file:get":
      if (!payload.profileId) throw new Error("profileId is required");
      return readProfileFile(home, payload.profileId, payload.file === "auth" ? "auth" : "config");
    case "profile:file:write":
      if (!payload.profileId) throw new Error("profileId is required");
      return writeProfileFile(home, payload.profileId, payload.file === "auth" ? "auth" : "config", payload.content, {
        execute: executeFromPayload(payload)
      });
    case "provider:create":
      return createProvider(home, payload);
    case "provider:officialFiles":
      return getOfficialProviderFiles(home);
    case "provider:useOfficial":
      return useOfficialProvider(home, { execute: executeFromPayload(payload) });
    default:
      throw new Error(`Unhandled action: ${action}`);
  }
}
