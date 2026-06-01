import type { ConfigSummary, ProviderBlock, ProviderKind } from "../types.js";

const OPENAI_PROVIDER_ID = "openai";
const BUILTIN_PROVIDER_IDS = new Set<string>([OPENAI_PROVIDER_ID, "ollama", "lmstudio"]);

type TomlScalar = string | number | boolean;
type Change = { scope: string; key: string; before: string; after: string };

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskToken(value: unknown): string {
  const text = String(value ?? "");
  if (text.length <= 12) return text ? "****" : "";
  return `${text.slice(0, 7)}...${text.slice(-4)}`;
}

function parseTomlScalar(raw: string): TomlScalar {
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function formatTomlValue(value: TomlScalar): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function tableHeaderName(line: string): string | null {
  const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
  return match ? match[1].trim() : null;
}

function providerKeyFromHeader(header: string): string | null {
  const match = header.match(/^model_providers\.(.+)$/);
  if (!match) return null;
  let key = match[1].trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  return key;
}

function normalizedProviderId(id: string): string {
  return id.trim();
}

function topLevelRange(lines: string[]): [number, number] {
  for (let i = 0; i < lines.length; i += 1) {
    if (isTableHeader(lines[i])) return [0, i];
  }
  return [0, lines.length];
}

function providerRange(lines: string[], key: string): [number, number] | null {
  for (let i = 0; i < lines.length; i += 1) {
    const header = tableHeaderName(lines[i]);
    if (header && providerKeyFromHeader(header) === key) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isTableHeader(lines[j])) {
          end = j;
          break;
        }
      }
      return [i, end];
    }
  }
  return null;
}

function readScalarInRange(lines: string[], start: number, end: number, key: string): TomlScalar | undefined {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = start; i < end; i += 1) {
    const match = lines[i].match(re);
    if (match) return parseTomlScalar(match[1]);
  }
  return undefined;
}

function setScalarInRange(
  lines: string[],
  start: number,
  end: number,
  key: string,
  value: TomlScalar | null,
  insertAt?: number
): { changed: boolean; removed?: boolean; inserted?: boolean } {
  const re = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=`);
  for (let i = start; i < end; i += 1) {
    const match = lines[i].match(re);
    if (match) {
      if (value === null) {
        lines.splice(i, 1);
        return { changed: true, removed: true };
      }
      const next = `${match[1]}${key} = ${formatTomlValue(value)}`;
      const changed = next !== lines[i];
      lines[i] = next;
      return { changed };
    }
  }
  if (value === null) return { changed: false };
  lines.splice(insertAt ?? end, 0, `${key} = ${formatTomlValue(value)}`);
  return { changed: true, inserted: true };
}

function setOfficialProviderInText(text: string): string {
  const lines = text ? text.split("\n") : [];
  let [, topEnd] = topLevelRange(lines);
  let result = setScalarInRange(lines, 0, topEnd, "model_provider", "openai", topEnd);
  if (result.inserted) topEnd += 1;
  if (readScalarInRange(lines, 0, topEnd, "model") === undefined) {
    result = setScalarInRange(lines, 0, topEnd, "model", "gpt-5.5", topEnd);
    if (result.inserted) topEnd += 1;
  }
  [, topEnd] = topLevelRange(lines);
  setScalarInRange(lines, 0, topEnd, "experimental_bearer_token", null, topEnd);
  const next = lines.join("\n");
  return next.endsWith("\n") ? next : `${next}\n`;
}

function summarizeConfig(text: string): ConfigSummary {
  const lines = text.split("\n");
  const [topStart, topEnd] = topLevelRange(lines);
  const model = readScalarInRange(lines, topStart, topEnd, "model");
  const configuredModelProvider = readScalarInRange(lines, topStart, topEnd, "model_provider");
  const modelProvider = configuredModelProvider ?? "openai";
  const bearer = readScalarInRange(lines, topStart, topEnd, "experimental_bearer_token");
  let provider: ProviderBlock | null = null;
  const providerKey = modelProvider ? String(modelProvider) : null;
  if (providerKey) {
    const range = providerRange(lines, providerKey);
    if (range) {
      const [ps, pe] = range;
      provider = {
        key: providerKey,
        name: readScalarInRange(lines, ps, pe, "name")?.toString() ?? null,
        baseUrl: readScalarInRange(lines, ps, pe, "base_url")?.toString() ?? null,
        wireApi: readScalarInRange(lines, ps, pe, "wire_api")?.toString() ?? null,
        requiresOpenaiAuth: readScalarInRange(lines, ps, pe, "requires_openai_auth") ?? null,
        envKey: readScalarInRange(lines, ps, pe, "env_key")?.toString() ?? null
      };
    }
  }
  return {
    model: model ?? null,
    modelProvider: modelProvider?.toString() ?? null,
    configuredModelProvider: configuredModelProvider?.toString() ?? null,
    provider,
    bearer: bearer
      ? { present: true, masked: maskToken(bearer), value: String(bearer) }
      : { present: false, masked: "", value: "" }
  };
}

function providerKind(provider: ProviderBlock | null, modelProvider: string | null): ProviderKind {
  // Any explicit [model_providers.<id>] block is a custom provider, even if it reuses a built-in id.
  if (provider) return "third-party";
  // No custom block: the built-in OpenAI id means the official, auth-based provider.
  if (modelProvider === OPENAI_PROVIDER_ID) return "official";
  return "unknown";
}

function isReservedProviderId(id: string): boolean {
  return BUILTIN_PROVIDER_IDS.has(normalizedProviderId(id));
}

function findReservedProviderBlocks(text: string): string[] {
  const found: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const header = tableHeaderName(line);
    if (!header) continue;
    const key = providerKeyFromHeader(header);
    if (key && isReservedProviderId(key) && !found.includes(key)) {
      found.push(key);
    }
  }
  return found;
}

function providerBlockIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const header = tableHeaderName(line);
    if (!header) continue;
    const key = providerKeyFromHeader(header);
    if (key && !ids.includes(key)) ids.push(key);
  }
  return ids;
}

function alignSingleProviderBlockToModelProvider(text: string): { text: string; changes: Change[] } {
  const providerId = summarizeConfig(text).configuredModelProvider?.toString().trim();
  if (!providerId) return { text, changes: [] };
  const ids = providerBlockIds(text);
  if (ids.includes(providerId) || ids.length !== 1) return { text, changes: [] };
  return renameProviderInText(text, ids[0], providerId);
}

function assertNoReservedProviderBlock(text: string): void {
  for (const id of findReservedProviderBlocks(text)) {
    throw new Error(`config.toml defines [model_providers.${id}], but "${id}" is a reserved built-in provider id that cannot be overridden. Rename it to a custom id.`);
  }
}

function providerIdFromConfigText(text: string): string {
  const summary = summarizeConfig(text);
  const providerId = summary.configuredModelProvider;
  if (!providerId) {
    throw new Error("config.toml must set model_provider for a custom provider.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(providerId)) {
    throw new Error("model_provider may only contain letters, numbers, dot, underscore, and hyphen");
  }
  if (isReservedProviderId(providerId)) {
    throw new Error(`"${providerId}" is a reserved built-in provider id. Use a custom id like "axis" or "openai-custom".`);
  }
  if (!summary.provider) {
    throw new Error(`config.toml must define [model_providers.${providerId}].`);
  }
  return providerId;
}

function assertCustomProviderConfig(text: string): void {
  providerIdFromConfigText(text);
}

function renameProviderInText(text: string, fromId: string, toId: string): { text: string; changes: Change[] } {
  const lines = text.split("\n");
  const changes: Change[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = tableHeaderName(lines[i]);
    if (header && providerKeyFromHeader(header) === fromId) {
      lines[i] = lines[i].replace(/\[model_providers\..*\]/, `[model_providers.${toId}]`);
      changes.push({ scope: "block", key: "header", before: fromId, after: toId });
    }
  }
  const [ts, te] = topLevelRange(lines);
  if (readScalarInRange(lines, ts, te, "model_provider") === fromId) {
    setScalarInRange(lines, ts, te, "model_provider", toId, te);
    changes.push({ scope: "top", key: "model_provider", before: fromId, after: toId });
  }
  return { text: lines.join("\n"), changes };
}

export {
  BUILTIN_PROVIDER_IDS,
  OPENAI_PROVIDER_ID,
  alignSingleProviderBlockToModelProvider,
  assertCustomProviderConfig,
  assertNoReservedProviderBlock,
  escapeRegex,
  findReservedProviderBlocks,
  providerIdFromConfigText,
  providerKind,
  renameProviderInText,
  setOfficialProviderInText,
  summarizeConfig
};
