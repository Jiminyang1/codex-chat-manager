const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set([
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

contextBridge.exposeInMainWorld("codexManager", {
  invoke(action, payload = {}) {
    if (!allowedActions.has(action)) {
      return Promise.reject(new Error(`Unknown action: ${action}`));
    }
    return ipcRenderer.invoke("codex-manager:invoke", action, payload);
  }
});
