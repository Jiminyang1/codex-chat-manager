function formatDate(seconds: unknown): string {
  if (!seconds) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(seconds) * 1000));
}

function shortPath(value: unknown): string {
  return value ? String(value).replace(/^\/Users\/[^/]+/, "~") : "";
}

function projectName(value: unknown): string {
  if (!value) return "(no project)";
  return String(value).split("/").filter(Boolean).at(-1) || shortPath(value);
}

function storedNumber(key: string, fallback: number): number {
  const value = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export {
  clamp,
  formatDate,
  projectName,
  shortPath,
  storedNumber
};
