const { contextBridge, ipcRenderer } = require("electron");
const { allowedActionNames } = require("../src/actions.cjs");

const allowedActions = new Set(allowedActionNames);

contextBridge.exposeInMainWorld("codexManager", {
  invoke(action: string, payload: unknown = {}) {
    if (!allowedActions.has(action)) {
      return Promise.reject(new Error(`Unknown action: ${action}`));
    }
    return ipcRenderer.invoke("codex-manager:invoke", action, payload);
  }
});
