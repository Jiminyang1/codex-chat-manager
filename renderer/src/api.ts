import type { ActionName, ActionPayload, ActionResult } from "../../src/actions.cjs";

export async function invoke<Action extends ActionName>(
  action: Action,
  payload: Partial<ActionPayload<Action>> & Record<string, unknown> = {}
): Promise<ActionResult<Action>> {
  const fullPayload = {
    codexHome: window.localStorage.getItem("codexHome") || "",
    ...payload
  };
  if (window.codexManager?.invoke) {
    return window.codexManager.invoke(action, fullPayload);
  }
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload: fullPayload })
  });
  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(data?.error || response.statusText);
  }
  return data as ActionResult<Action>;
}

export function setCodexHome(value: string): void {
  window.localStorage.setItem("codexHome", value || "");
}

export function getCodexHome(): string {
  return window.localStorage.getItem("codexHome") || "";
}
