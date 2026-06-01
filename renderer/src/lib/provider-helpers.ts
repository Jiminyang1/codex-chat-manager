import type { JsonRecord } from "../../../src/types";

function profileSummary(raw: string): JsonRecord {
  const provider = raw?.match(/^model_provider\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "") ?? "-";
  const baseUrl = raw?.match(/^base_url\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "") ?? "-";
  const modelLine = raw?.split("\n").find((line: string) => /^\s*model\s*=/.test(line) && !/model_provider/.test(line));
  return {
    provider,
    baseUrl,
    model: modelLine ? modelLine.split("=")[1].trim().replaceAll("\"", "") : "-"
  };
}

function providerIdFromConfig(raw: string): string {
  return raw?.match(/^model_provider\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "").trim() ?? "";
}

function officialSwitchMessage(snapshot: JsonRecord | null | undefined): string {
  if (snapshot?.source === "profile" && snapshot.hasOfficialAuth !== false) {
    const label = snapshot.autoManaged ? "the auto-saved OpenAI Official snapshot" : `"${snapshot.label}"`;
    return `Use ${label} and restore auth.json.`;
  }
  if (snapshot?.source === "backup") {
    if (snapshot.hasOfficialAuth) {
      return `Use backup config "${snapshot.label}" with current OpenAI login.`;
    }
    return `Backup "${snapshot.label}" has no usable auth.json.`;
  }
  return "Use OpenAI Official with current auth.json.";
}

function providerIdFromLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function defaultProviderConfig(providerId: string): string {
  const safeProviderId = providerId || "custom";
  return [
    `model_provider = "${safeProviderId}"`,
    'model = "gpt-5.5"',
    "",
    `[model_providers.${safeProviderId}]`,
    `name = "${safeProviderId}"`,
    'base_url = "https://api.example.com/v1"',
    'wire_api = "responses"',
    ""
  ].join("\n");
}

function updateProviderIdInDraftConfig(configText: string, previousId: string, nextId: string): string {
  const oldId = previousId || "custom";
  const safeNextId = nextId || "custom";
  const oldConfig = defaultProviderConfig(oldId);
  if (!configText || configText === oldConfig) return defaultProviderConfig(safeNextId);
  return configText;
}

function defaultProviderAuth(): string {
  return `${JSON.stringify({ OPENAI_API_KEY: "" }, null, 2)}\n`;
}

export {
  defaultProviderAuth,
  defaultProviderConfig,
  officialSwitchMessage,
  profileSummary,
  providerIdFromConfig,
  providerIdFromLabel,
  updateProviderIdInDraftConfig
};
