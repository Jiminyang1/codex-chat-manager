import type { JsonRecord } from "../../../src/types";

const BUILTIN_PROVIDER_IDS = new Set(["openai", "ollama", "lmstudio"]);

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
  const match = raw?.match(/^\s*model_provider\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
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

function isReservedProviderId(value: unknown): boolean {
  return BUILTIN_PROVIDER_IDS.has(String(value ?? "").trim());
}

function providerBlockIdsFromConfig(raw: string): string[] {
  const ids: string[] = [];
  for (const line of String(raw ?? "").split("\n")) {
    const match = line.match(/^\s*\[model_providers\.(?:"([^"]+)"|([^\]]+))\]\s*$/);
    const id = String(match?.[1] ?? match?.[2] ?? "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function alignProviderBlockWithModelProvider(raw: string): string {
  const providerId = providerIdFromConfig(raw);
  if (!providerId) return raw;
  const blockIds = providerBlockIdsFromConfig(raw);
  if (blockIds.includes(providerId) || blockIds.length !== 1) return raw;
  return String(raw ?? "")
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)\[model_providers\.(?:"([^"]+)"|([^\]]+))\](\s*)$/);
      if (!match) return line;
      return `${match[1]}[model_providers.${providerId}]${match[4] ?? ""}`;
    })
    .join("\n");
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

function defaultProviderAuth(): string {
  return `${JSON.stringify({ OPENAI_API_KEY: "" }, null, 2)}\n`;
}

export {
  alignProviderBlockWithModelProvider,
  defaultProviderAuth,
  defaultProviderConfig,
  isReservedProviderId,
  officialSwitchMessage,
  profileSummary,
  providerIdFromConfig
};
