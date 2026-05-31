export async function invoke(action, payload = {}) {
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
  return data;
}

export function setCodexHome(value) {
  window.localStorage.setItem("codexHome", value || "");
}

export function getCodexHome() {
  return window.localStorage.getItem("codexHome") || "";
}
