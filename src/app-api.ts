import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import type { ActionName, ActionPayload, ActionResult } from "./actions.cjs";
import { isCodexDesktopRunning, quitCodexDesktop } from "./codex-process.js";
import {
  createProvider,
  deleteBackup,
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

const require = createRequire(import.meta.url);
const { allowedActionNames, parseActionPayload } = require("./actions.cjs") as typeof import("./actions.cjs");

export const defaultCodexHome = path.join(os.homedir(), ".codex");

export const allowedActions = new Set<ActionName>(allowedActionNames);

export function safeCodexHome(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultCodexHome;
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

function executeFromPayload(payload: { confirmed?: boolean }): boolean {
  return payload?.confirmed === true;
}

export async function invokeAction<Action extends ActionName>(
  action: Action,
  payload?: unknown
): Promise<ActionResult<Action>>;
export async function invokeAction(action: string, payload?: unknown): Promise<any>;
export async function invokeAction(action: string, payload: unknown = {}): Promise<any> {
  if (!allowedActions.has(action as ActionName)) {
    throw new Error(`Unknown action: ${action}`);
  }
  const parsedPayload = parseActionPayload(action as ActionName, payload);
  const home = safeCodexHome(parsedPayload.codexHome);

  switch (action) {
    case "status:get":
      return getStatus(home);
    case "projects:list":
      return getProjects(home);
    case "projectlessThreads:list":
      {
        const data = parsedPayload as ActionPayload<"projectlessThreads:list">;
        return getProjectlessThreads(home, {
          provider: data.provider,
          archived: data.archived
        });
      }
    case "threads:list":
      {
        const data = parsedPayload as ActionPayload<"threads:list">;
        return readThreads(home, {
          all: true,
          ids: data.ids,
          project: data.project,
          provider: data.provider,
          archived: data.archived
        });
      }
    case "backups:list":
      return listBackups(home);
    case "codex:processStatus":
      return isCodexDesktopRunning();
    case "codex:quit":
      return quitCodexDesktop();
    case "thread:trash": {
      const data = parsedPayload as ActionPayload<"thread:trash">;
      const thread = readThreadByRef(home, data.threadId);
      if (!thread) throw new Error(`Chat not found: ${data.threadId}`);
      return trashThreads(home, [thread], {
        execute: executeFromPayload(data),
        reason: `trash-thread:${data.threadId}`
      });
    }
    case "threads:trash": {
      const data = parsedPayload as ActionPayload<"threads:trash">;
      const threads = data.threadIds.map((threadId) => {
        const thread = readThreadByRef(home, threadId);
        if (!thread) throw new Error(`Chat not found: ${threadId}`);
        return thread;
      });
      const uniqueThreads = [...new Map(threads.map((thread) => [thread.id, thread])).values()];
      return trashThreads(home, uniqueThreads, {
        execute: executeFromPayload(data),
        reason: `trash-threads:${uniqueThreads.length}`
      });
    }
    case "project:delete": {
      const data = parsedPayload as ActionPayload<"project:delete">;
      return deleteProject(home, data.project, { execute: executeFromPayload(data) });
    }
    case "backup:restore": {
      const data = parsedPayload as ActionPayload<"backup:restore">;
      return restoreBackup(home, data.backupDir, executeFromPayload(data), data.scope);
    }
    case "backup:delete": {
      const data = parsedPayload as ActionPayload<"backup:delete">;
      return deleteBackup(home, data.backupDir, { execute: executeFromPayload(data) });
    }
    case "config:get":
      return getConfigOverview(home);
    case "config:file:get":
      {
        const data = parsedPayload as ActionPayload<"config:file:get">;
        return readConfigFile(home, data.file ?? "config");
      }
    case "config:file:write":
      {
        const data = parsedPayload as ActionPayload<"config:file:write">;
        return writeConfigFile(home, data.file ?? "config", data.content, {
          execute: executeFromPayload(data)
        });
      }
    case "config:fix":
      {
        const data = parsedPayload as ActionPayload<"config:fix">;
        return fixReservedProviders(home, {
          toId: data.to || "openai-custom",
          execute: executeFromPayload(data)
        });
      }
    case "config:sync":
      {
        const data = parsedPayload as ActionPayload<"config:sync">;
        return syncProviderTag(home, {
          toId: data.to || undefined,
          mode: data.mode ?? "retag",
          execute: executeFromPayload(data)
        });
      }
    case "profile:switch":
      {
        const data = parsedPayload as ActionPayload<"profile:switch">;
        return switchProfile(home, data.profileId, { execute: executeFromPayload(data) });
      }
    case "profile:save":
      {
        const data = parsedPayload as ActionPayload<"profile:save">;
        return saveProfile(home, {
          label: data.label,
          note: data.note ?? "",
          kind: data.kind
        });
      }
    case "profile:delete":
      {
        const data = parsedPayload as ActionPayload<"profile:delete">;
        return deleteProfile(home, data.id, { execute: executeFromPayload(data) });
      }
    case "profile:file:get":
      {
        const data = parsedPayload as ActionPayload<"profile:file:get">;
        return readProfileFile(home, data.profileId, data.file ?? "config");
      }
    case "profile:file:write":
      {
        const data = parsedPayload as ActionPayload<"profile:file:write">;
        return writeProfileFile(home, data.profileId, data.file ?? "config", data.content, {
          execute: executeFromPayload(data)
        });
      }
    case "provider:create":
      return createProvider(home, parsedPayload as ActionPayload<"provider:create">);
    case "provider:officialFiles":
      return getOfficialProviderFiles(home);
    case "provider:useOfficial":
      return useOfficialProvider(home, { execute: executeFromPayload(parsedPayload as { confirmed?: boolean }) });
    default:
      throw new Error(`Unhandled action: ${action}`);
  }
}
