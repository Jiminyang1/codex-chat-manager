import fs from "node:fs/promises";
import path from "node:path";
import {
  assertThreadRolloutsInsideHome,
  collectProviderConsistencyMismatches,
  collectProviderTagMismatches,
  createBackup,
  listBackups,
  openDb,
  prepareRolloutProviderUpdate,
  readJsonIfPresent,
  restoreMutationBackup,
  timestamp,
  writeFilePreservingTimes
} from "./state.js";
import { readTextIfPresent, writeTextIfChanged } from "./io.js";
import {
  BUILTIN_PROVIDER_IDS,
  assertCustomProviderConfig,
  assertNoReservedProviderBlock,
  escapeRegex,
  findReservedProviderBlocks,
  providerIdFromConfigText,
  providerKind,
  renameProviderInText,
  setOfficialProviderInText,
  summarizeConfig
} from "./config-text.js";
import type { AuthSummary, ConfigFileName, ConfigOverview, JsonRecord, ProviderProfile, SyncMode } from "../types.js";

const CONFIG_NAME = "config.toml";
const AUTH_NAME = "auth.json";
const PROFILE_DIR = "chat-manager-profiles";
const PROFILE_INDEX = "profiles.json";
const OFFICIAL_PROFILE_ID = "openai-official";
const OFFICIAL_PROFILE_LABEL = "OpenAI Official";

// Provider switching and profile management

type ExecuteOptions = { execute: boolean };
type ProfileEntry = ProviderProfile & {
  providerId?: string | null;
  hasAuth?: boolean;
  autoDetected?: boolean;
  autoManaged?: boolean;
};
type OfficialSource = JsonRecord & {
  available?: boolean;
  source?: string;
  label?: string;
  configText?: string | null;
  authText?: string | null;
  authSource?: string;
  hasOfficialAuth?: boolean;
};

function configPath(home: string): string {
  return path.join(home, CONFIG_NAME);
}

function authPath(home: string): string {
  return path.join(home, AUTH_NAME);
}

function profileDir(home: string): string {
  return path.join(home, PROFILE_DIR);
}

function profileIndexPath(home: string): string {
  return path.join(profileDir(home), PROFILE_INDEX);
}

async function readAuthSummary(home: string): Promise<AuthSummary> {
  const auth = await readJsonIfPresent(authPath(home), null);
  if (!auth) return { exists: false, mode: null, hasApiKey: false, apiKey: null };
  return {
    exists: true,
    mode: auth.auth_mode ?? null,
    hasApiKey: Boolean(auth.OPENAI_API_KEY),
    apiKey: auth.OPENAI_API_KEY ?? null
  };
}

function isOfficialAuthText(raw: unknown): boolean {
  if (!raw) return false;
  try {
    const auth = JSON.parse(String(raw));
    return Boolean(auth?.auth_mode) && !auth.OPENAI_API_KEY;
  } catch {
    return false;
  }
}

async function readCurrentOfficialAuthText(home: string): Promise<string | null> {
  const authText = await readTextIfPresent(authPath(home), null);
  return isOfficialAuthText(authText) ? authText : null;
}

function officialProfileConfigPath(home: string): string {
  return path.join(profileDir(home), `${OFFICIAL_PROFILE_ID}.toml`);
}

function officialProfileAuthPath(home: string): string {
  return path.join(profileDir(home), `${OFFICIAL_PROFILE_ID}.auth.json`);
}

async function profileConfigText(home: string, profileId: string): Promise<string | null> {
  return readTextIfPresent(path.join(profileDir(home), `${profileId}.toml`), null);
}

async function profileProviderId(home: string, entry: ProfileEntry): Promise<string | null> {
  if (entry.providerId) return entry.providerId;
  const configText = await profileConfigText(home, entry.id);
  if (configText === null) return null;
  return summarizeConfig(configText).modelProvider ?? null;
}

async function removeProfileSnapshotFiles(home: string, profileId: string): Promise<void> {
  await fs.rm(path.join(profileDir(home), `${profileId}.toml`), { force: true });
  await fs.rm(path.join(profileDir(home), `${profileId}.auth.json`), { force: true });
}

async function cleanupAutoDetectedThirdPartyProfiles(home: string): Promise<JsonRecord> {
  const profiles = await readProfileIndex(home);
  const stale = profiles.filter((profile) => (
    profile.autoDetected === true
    && profile.autoManaged !== true
    && profile.id !== OFFICIAL_PROFILE_ID
  ));
  if (!stale.length) return { removed: 0, ids: [] };
  for (const profile of stale) {
    await removeProfileSnapshotFiles(home, profile.id);
  }
  await writeProfileIndex(home, profiles.filter((profile) => !stale.some((item) => item.id === profile.id)));
  return { removed: stale.length, ids: stale.map((profile) => profile.id) };
}

function upsertProfile(profiles: ProfileEntry[], entry: ProfileEntry): ProfileEntry[] {
  const existing = profiles.find((profile) => profile.id === entry.id);
  return existing
    ? profiles.map((profile) => (profile.id === entry.id ? { ...profile, ...entry, createdAt: profile.createdAt ?? entry.createdAt } : profile))
    : [...profiles, entry];
}

async function ensureOfficialProviderSnapshot(home: string): Promise<JsonRecord> {
  const configText = await readTextIfPresent(configPath(home), null);
  const authText = await readTextIfPresent(authPath(home), null);
  if (configText === null || authText === null || !isOfficialAuthText(authText)) {
    return { saved: false, reason: "not-official-auth" };
  }

  const summary = summarizeConfig(configText);
  if (providerKind(summary.provider, summary.modelProvider) !== "official") {
    return { saved: false, reason: "not-official-config" };
  }

  await fs.mkdir(profileDir(home), { recursive: true });
  const wroteConfig = await writeTextIfChanged(officialProfileConfigPath(home), configText);
  const wroteAuth = await writeTextIfChanged(officialProfileAuthPath(home), authText);
  const profiles = await readProfileIndex(home);
  const now = new Date().toISOString();
  const existing = profiles.find((profile) => profile.id === OFFICIAL_PROFILE_ID);
  const nextEntry = {
    ...(existing ?? {}),
    id: OFFICIAL_PROFILE_ID,
    label: OFFICIAL_PROFILE_LABEL,
    note: "Automatically refreshed while current Codex auth is OpenAI Official.",
    kind: "official",
    hasAuth: true,
    autoManaged: true,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now
  };
  await writeProfileIndex(home, upsertProfile(profiles, nextEntry));
  return {
    saved: wroteConfig || wroteAuth || !existing,
    profile: nextEntry,
    wroteConfig,
    wroteAuth
  };
}

async function reconcileCurrentProvider(home: string): Promise<JsonRecord> {
  const thirdPartyCleanup = await cleanupAutoDetectedThirdPartyProfiles(home);
  const configText = await readTextIfPresent(configPath(home), "") ?? "";
  const authText = await readTextIfPresent(authPath(home), null);
  const summary = summarizeConfig(configText);
  const kind = providerKind(summary.provider, summary.modelProvider);
  if (kind === "official" && isOfficialAuthText(authText)) {
    return { kind, official: await ensureOfficialProviderSnapshot(home), thirdParty: thirdPartyCleanup };
  }
  if (kind === "third-party") {
    return {
      kind,
      official: { saved: false, reason: "not-official-config" },
      thirdParty: thirdPartyCleanup
    };
  }
  return {
    kind,
    official: { saved: false, reason: "not-official" },
    thirdParty: thirdPartyCleanup
  };
}

async function findOfficialAuthSnapshot(home: string): Promise<JsonRecord | null> {
  const profiles = await readProfileIndex(home);
  const sorted = [...profiles].sort((left, right) => {
    if (left.id === OFFICIAL_PROFILE_ID) return -1;
    if (right.id === OFFICIAL_PROFILE_ID) return 1;
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
  for (const entry of sorted) {
    if (entry.hasAuth !== true) continue;
    const configSnapshot = await readTextIfPresent(path.join(profileDir(home), `${entry.id}.toml`), null);
    const authSnapshot = await readTextIfPresent(path.join(profileDir(home), `${entry.id}.auth.json`), null);
    if (configSnapshot === null || authSnapshot === null || !isOfficialAuthText(authSnapshot)) continue;
    const summary = summarizeConfig(configSnapshot);
    if (providerKind(summary.provider, summary.modelProvider) !== "official") continue;
    return { profile: entry, configText: configSnapshot, authText: authSnapshot };
  }
  return null;
}

async function findOfficialBackupSnapshot(home: string): Promise<JsonRecord | null> {
  const backups = await listBackups(home);
  for (const backup of backups) {
    const configText = await readTextIfPresent(path.join(backup.path, CONFIG_NAME), null);
    if (configText === null) continue;
    const summary = summarizeConfig(configText);
    if (providerKind(summary.provider, summary.modelProvider) !== "official") continue;
    const authText = await readTextIfPresent(path.join(backup.path, AUTH_NAME), null);
    return {
      backup,
      configText,
      authText,
      hasOfficialAuth: isOfficialAuthText(authText)
    };
  }
  return null;
}

function officialProfileInfo(snapshot: JsonRecord): JsonRecord {
  return {
    available: true,
    source: "profile",
    profileId: snapshot.profile.id,
    label: snapshot.profile.label ?? snapshot.profile.id,
    createdAt: snapshot.profile.createdAt ?? null,
    updatedAt: snapshot.profile.updatedAt ?? null,
    autoManaged: snapshot.profile.autoManaged === true,
    hasAuth: true,
    hasOfficialAuth: true
  };
}

function officialBackupInfo(snapshot: JsonRecord, currentOfficialAuthText: string | null = null): JsonRecord {
  const authSource = snapshot.authText !== null ? "backup" : currentOfficialAuthText ? "current" : "missing";
  return {
    available: true,
    source: "backup",
    profileId: null,
    backupDir: snapshot.backup.path,
    label: snapshot.backup.reason || snapshot.backup.name,
    createdAt: snapshot.backup.createdAt,
    hasAuth: authSource !== "missing",
    hasOfficialAuth: snapshot.hasOfficialAuth || authSource === "current",
    authSource
  };
}

async function resolveOfficialProviderSource(home: string): Promise<OfficialSource> {
  const profileSnapshot = await findOfficialAuthSnapshot(home);
  if (profileSnapshot) {
    return {
      ...officialProfileInfo(profileSnapshot),
      configText: profileSnapshot.configText,
      authText: profileSnapshot.authText,
      authSource: "profile"
    };
  }

  const backupSnapshot = await findOfficialBackupSnapshot(home);
  if (backupSnapshot) {
    const currentAuthText = await readCurrentOfficialAuthText(home);
    return {
      ...officialBackupInfo(backupSnapshot, currentAuthText),
      configText: backupSnapshot.configText,
      authText: backupSnapshot.authText ?? currentAuthText
    };
  }

  const currentAuthText = await readCurrentOfficialAuthText(home);
  if (currentAuthText) {
    return {
      available: true,
      source: "current",
      label: "Current OpenAI login",
      hasAuth: true,
      hasOfficialAuth: true,
      authSource: "current",
      configText: setOfficialProviderInText(await readTextIfPresent(configPath(home), "") ?? ""),
      authText: currentAuthText
    };
  }

  return { available: false, source: "missing", hasAuth: false, hasOfficialAuth: false, authText: null, configText: null };
}

function publicOfficialSourceInfo(source: OfficialSource): JsonRecord {
  const { configText, authText, ...info } = source;
  return info;
}

async function getOfficialProviderFiles(home: string): Promise<JsonRecord> {
  await reconcileCurrentProvider(home);
  const source = await resolveOfficialProviderSource(home);
  return {
    ...source,
    config: source.configText ?? "",
    auth: source.authText ?? "",
    missing: !source.available
  };
}

function configFilePath(home: string, file?: ConfigFileName): string {
  if (file === "auth") return authPath(home);
  if (file === "config" || file === undefined) return configPath(home);
  throw new Error(`Unknown file "${file}"; use config or auth`);
}

async function readConfigFile(home: string, file?: ConfigFileName): Promise<JsonRecord> {
  const filePath = configFilePath(home, file);
  const raw = await readTextIfPresent(filePath, null);
  return { file: file ?? "config", path: filePath, exists: raw !== null, raw: raw ?? "" };
}

async function writeConfigFile(home: string, file: ConfigFileName | undefined, content: string, { execute }: ExecuteOptions): Promise<JsonRecord> {
  const filePath = configFilePath(home, file);
  if (file === "auth") {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`Refusing to save: auth.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (file !== "auth") {
    assertNoReservedProviderBlock(content);
  }
  if (!execute) {
    return { dryRun: true, file: file ?? "config", path: filePath, bytes: Buffer.byteLength(content, "utf8") };
  }
  const backupDir = await createBackup(home, `config-file-write:${file ?? "config"}`, []);
  await fs.writeFile(filePath, content);
  return { dryRun: false, file: file ?? "config", path: filePath, backupDir };
}

function assertProfileId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid profile id: ${id || "(empty)"}`);
  }
  return id;
}

async function requireProfile(home: string, profileId: string): Promise<ProfileEntry> {
  const id = assertProfileId(profileId);
  const entry = (await readProfileIndex(home)).find((profile) => profile.id === id);
  if (!entry) throw new Error(`Profile not found: ${id}`);
  return entry;
}

async function readProfileFile(home: string, profileId: string, file: ConfigFileName = "config"): Promise<JsonRecord> {
  const entry = await requireProfile(home, profileId);
  const safeFile = file === "auth" ? "auth" : "config";
  const filePath = path.join(profileDir(home), `${entry.id}.${safeFile === "auth" ? "auth.json" : "toml"}`);
  const raw = await readTextIfPresent(filePath, null);
  return { profileId: entry.id, file: safeFile, path: filePath, exists: raw !== null, raw: raw ?? "" };
}

async function writeProfileFile(home: string, profileId: string, file: ConfigFileName | undefined, content: string, { execute }: ExecuteOptions): Promise<JsonRecord> {
  const entry = await requireProfile(home, profileId);
  const safeFile = file === "auth" ? "auth" : "config";
  if (typeof content !== "string") throw new Error("content is required");
  if (safeFile === "auth") {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    assertNoReservedProviderBlock(content);
    if (entry.kind !== "official") {
      assertCustomProviderConfig(content);
    }
  }
  const filePath = path.join(profileDir(home), `${entry.id}.${safeFile === "auth" ? "auth.json" : "toml"}`);
  if (!execute) {
    return { dryRun: true, file: safeFile, path: filePath, bytes: Buffer.byteLength(content, "utf8") };
  }
  await fs.writeFile(filePath, content);
  if (safeFile === "config") {
    const summary = summarizeConfig(content);
    const profiles = await readProfileIndex(home);
    await writeProfileIndex(home, profiles.map((profile) => (
      profile.id === entry.id ? { ...profile, providerId: summary.modelProvider, kind: providerKind(summary.provider, summary.modelProvider) } : profile
    )));
  } else if (entry.hasAuth !== true) {
    const profiles = await readProfileIndex(home);
    await writeProfileIndex(home, profiles.map((profile) => (
      profile.id === entry.id ? { ...profile, hasAuth: true } : profile
    )));
  }
  return { dryRun: false, file: safeFile, path: filePath, saved: true };
}

async function readProfileIndex(home: string): Promise<ProfileEntry[]> {
  const index = await readJsonIfPresent(profileIndexPath(home), null);
  return Array.isArray(index?.profiles) ? index.profiles : [];
}

async function writeProfileIndex(home: string, profiles: ProfileEntry[]): Promise<void> {
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(profileIndexPath(home), `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
}

async function listProfiles(home: string, currentText: string): Promise<ProviderProfile[]> {
  const entries = await readProfileIndex(home);
  const currentProviderId = summarizeConfig(currentText).modelProvider;
  const visible: Array<{ key: string; entry: ProfileEntry; providerId: string | null }> = [];
  const seenProviderIds = new Set<string>();
  for (const entry of entries) {
    if (entry.autoManaged === true && entry.id === OFFICIAL_PROFILE_ID) continue;
    const providerId = await profileProviderId(home, entry);
    if (providerId) {
      const key = `${entry.kind ?? "custom"}:${providerId}`;
      const existingIndex = visible.findIndex((profile) => profile.key === key);
      if (existingIndex !== -1) {
        const previous = visible[existingIndex].entry;
        if (previous.autoDetected === true && entry.autoDetected !== true) {
          visible[existingIndex] = { key, entry, providerId };
        }
        continue;
      }
      if (entry.autoDetected === true && seenProviderIds.has(providerId)) continue;
      seenProviderIds.add(providerId);
      visible.push({ key, entry, providerId });
    } else {
      visible.push({ key: `missing:${entry.id}`, entry, providerId: null });
    }
  }
  const profiles: ProviderProfile[] = [];
  for (const { entry, providerId } of visible) {
    const file = path.join(profileDir(home), `${entry.id}.toml`);
    const snapshot = await readTextIfPresent(file, null);
    profiles.push({
      id: entry.id,
      label: entry.label ?? entry.id,
      note: entry.note ?? "",
      kind: entry.kind ?? "custom",
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      autoDetected: entry.autoDetected === true,
      providerId,
      missing: snapshot === null,
      hasAuth: entry.hasAuth === true,
      active: providerId !== null && providerId === currentProviderId
    });
  }
  return profiles.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function getConfigOverview(home: string): Promise<ConfigOverview> {
  const reconciled = await reconcileCurrentProvider(home);
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  const summary = summarizeConfig(text);
  const authSummary = await readAuthSummary(home);
  const officialSource = await resolveOfficialProviderSource(home);
  const officialInfo = publicOfficialSourceInfo(officialSource);
  return {
    codexHome: home,
    configPath: configPath(home),
    exists: text.length > 0,
    raw: text,
    ...summary,
    kind: providerKind(summary.provider, summary.modelProvider),
    reservedBlocks: findReservedProviderBlocks(text),
    auth: authSummary,
    officialAuthSnapshot: officialInfo,
    autoOfficialSnapshot: reconciled.official,
    autoThirdPartyProfile: reconciled.thirdParty,
    profiles: await listProfiles(home, text)
  };
}

async function saveProfile(home: string, { label, note = "", kind }: { label: string; note?: string; kind?: string }): Promise<JsonRecord> {
  if (!label) throw new Error("Profile label is required");
  const text = await readTextIfPresent(configPath(home), null);
  if (text === null) throw new Error("No config.toml found to capture");
  const authText = await readTextIfPresent(authPath(home), null);
  const id = `${timestamp()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(path.join(profileDir(home), `${id}.toml`), text);
  const hasAuth = authText !== null;
  if (hasAuth) {
    await fs.writeFile(path.join(profileDir(home), `${id}.auth.json`), authText);
  }
  const summary = summarizeConfig(text);
  const profiles = await readProfileIndex(home);
  const entry = {
    id,
    label,
    note,
    kind: kind ?? providerKind(summary.provider, summary.modelProvider),
    providerId: summary.modelProvider,
    hasAuth,
    createdAt: new Date().toISOString()
  };
  profiles.push(entry);
  await writeProfileIndex(home, profiles);
  return { saved: true, profile: entry };
}

async function createProvider(home: string, {
  label,
  configText,
  authText,
  switch: shouldSwitch = false
}: { label: string; configText: string; authText?: string; switch?: boolean }): Promise<JsonRecord> {
  const safeLabel = String(label ?? "").trim();
  if (!safeLabel) throw new Error("label is required");

  if (typeof configText !== "string" || !configText.trim()) {
    throw new Error("configText is required");
  }
  assertNoReservedProviderBlock(configText);
  providerIdFromConfigText(configText);
  const normalizedConfigText = configText.endsWith("\n") ? configText : `${configText}\n`;

  let normalizedAuthText = null;
  if (typeof authText === "string" && authText.trim()) {
    try {
      JSON.parse(authText);
    } catch (error) {
      throw new Error(`authText is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    normalizedAuthText = authText.endsWith("\n") ? authText : `${authText}\n`;
  }
  const result = await saveProfileFromText(home, {
    label: safeLabel,
    note: "",
    kind: "third-party",
    configText: normalizedConfigText,
    authText: normalizedAuthText
  });
  if (shouldSwitch) {
    await switchProfile(home, result.profile.id, { execute: true });
  }
  return { saved: true, profile: result.profile, switched: Boolean(shouldSwitch) };
}

async function saveProfileFromText(
  home: string,
  { label, note = "", kind = "custom", configText, authText = null }: {
    label: string;
    note?: string;
    kind?: string;
    configText: string;
    authText?: string | null;
  }
): Promise<JsonRecord> {
  const id = `${timestamp()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(path.join(profileDir(home), `${id}.toml`), configText);
  const hasAuth = authText !== null;
  if (hasAuth) {
    await fs.writeFile(path.join(profileDir(home), `${id}.auth.json`), authText);
  }
  const profiles = await readProfileIndex(home);
  const summary = summarizeConfig(configText);
  const entry = {
    id,
    label,
    note,
    kind,
    providerId: summary.modelProvider,
    hasAuth,
    createdAt: new Date().toISOString()
  };
  profiles.push(entry);
  await writeProfileIndex(home, profiles);
  return { saved: true, profile: entry };
}

async function useOfficialProvider(home: string, { execute }: ExecuteOptions): Promise<JsonRecord> {
  await reconcileCurrentProvider(home);
  const officialSource = await resolveOfficialProviderSource(home);
  const content = officialSource.configText ?? setOfficialProviderInText(await readTextIfPresent(configPath(home), "") ?? "");
  assertNoReservedProviderBlock(content);
  const authToWrite = officialSource.authSource === "current" ? null : officialSource.authText;
  const hasOfficialAuth = officialSource.hasOfficialAuth === true;
  const authSource = officialSource.available ? publicOfficialSourceInfo(officialSource) : null;
  const changes = [
    { file: "config.toml", before: "(current)", after: "OpenAI Official" }
  ];
  if (authToWrite) {
    changes.push({ file: "auth.json", before: "(current)", after: `${officialSource.source} "${officialSource.label ?? officialSource.source}"` });
  }

  if (!execute) {
    return {
      dryRun: true,
      file: "config",
      path: configPath(home),
      bytes: Buffer.byteLength(content, "utf8"),
      changes,
      willWriteAuth: Boolean(authToWrite),
      hasOfficialAuth,
      authSource,
      configText: content
    };
  }

  if (!hasOfficialAuth) {
    throw new Error("No OpenAI Official auth snapshot found. Open Codex with OpenAI Official once so Codex Manager can auto-save config.toml and auth.json, then switch back from a custom provider.");
  }

  await fs.writeFile(configPath(home), content);
  if (authToWrite) {
    await fs.writeFile(authPath(home), authToWrite);
  }
  return {
    dryRun: false,
    file: "config",
    path: configPath(home),
    switched: true,
    wroteConfig: true,
    wroteAuth: Boolean(authToWrite),
    retainedCurrentAuth: !authToWrite,
    authSource,
    configText: content
  };
}

async function deleteProfile(home: string, id: string, { execute }: ExecuteOptions): Promise<JsonRecord> {
  const profiles = await readProfileIndex(home);
  const entry = profiles.find((profile) => profile.id === id);
  if (!entry) throw new Error(`Profile not found: ${id}`);
  if (entry.id === OFFICIAL_PROFILE_ID || entry.autoManaged === true) {
    throw new Error("OpenAI Official backup is managed automatically and cannot be deleted.");
  }
  if (!execute) return { dryRun: true, profile: entry };
  await writeProfileIndex(home, profiles.filter((profile) => profile.id !== id));
  await fs.rm(path.join(profileDir(home), `${id}.toml`), { force: true });
  await fs.rm(path.join(profileDir(home), `${id}.auth.json`), { force: true });
  return { dryRun: false, deleted: true, profile: entry };
}

async function switchProfile(home: string, profileId: string, { execute }: ExecuteOptions): Promise<JsonRecord> {
  const entry = (await readProfileIndex(home)).find((p) => p.id === profileId);
  if (!entry) throw new Error(`Profile not found: ${profileId}`);
  const configSnapshot = await readTextIfPresent(path.join(profileDir(home), `${profileId}.toml`), null);
  if (configSnapshot === null) throw new Error(`Profile config missing: ${profileId}`);
  if (entry.kind !== "official") {
    assertCustomProviderConfig(configSnapshot);
  }
  const authSnapshot = await readTextIfPresent(path.join(profileDir(home), `${profileId}.auth.json`), null);
  const willWriteAuth = authSnapshot !== null;

  if (!execute) {
    const changes = [
      { file: "config.toml", before: "(current)", after: `profile "${entry.label}"` }
    ];
    if (willWriteAuth) changes.push({ file: "auth.json", before: "(current)", after: `profile "${entry.label}"` });
    return { dryRun: true, profile: entry, changes, willWriteAuth };
  }

  await fs.writeFile(configPath(home), configSnapshot);
  if (willWriteAuth) {
    await fs.writeFile(authPath(home), authSnapshot);
  }
  return { dryRun: false, profile: entry, wroteConfig: true, wroteAuth: willWriteAuth };
}

async function fixReservedProviders(home: string, { toId = "openai-custom", execute }: { toId?: string; execute: boolean }): Promise<JsonRecord> {
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  let next = text;
  const allChanges = [];
  for (const id of BUILTIN_PROVIDER_IDS) {
    const re = new RegExp(`^\\s*\\[model_providers\\.(?:"${escapeRegex(id)}"|${escapeRegex(id)})\\]`, "m");
    if (re.test(next)) {
      const result = renameProviderInText(next, id, toId);
      next = result.text;
      allChanges.push(...result.changes);
    }
  }
  if (!allChanges.length) {
    return { dryRun: !execute, noOp: true, changes: [] };
  }
  if (!execute) {
    return { dryRun: true, toId, changes: allChanges };
  }
  const backupDir = await createBackup(home, `config-fix-reserved:${toId}`, []);
  await fs.writeFile(configPath(home), next);
  return { dryRun: false, toId, changes: allChanges, backupDir };
}

async function syncProviderTag(home: string, { toId, execute, mode = "retag" }: { toId?: string; execute: boolean; mode?: SyncMode }): Promise<JsonRecord> {
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  const target = (toId && String(toId).trim()) || summarizeConfig(text).modelProvider;
  const safeMode = mode === "repair" ? "repair" : "retag";
  if (safeMode === "retag" && !target) {
    throw new Error("No target provider id; set model_provider in config.toml or pass --to <id>");
  }
  const { mismatches, groups } = safeMode === "repair"
    ? await collectProviderConsistencyMismatches(home, { strictRolloutPaths: true })
    : await collectProviderTagMismatches(home, target ?? "", { strictRolloutPaths: true });
  const total = mismatches.length;

  if (!execute) {
    return { dryRun: true, mode: safeMode, target: safeMode === "retag" ? target : null, groups, total };
  }
  if (!total) {
    return { dryRun: false, mode: safeMode, target: safeMode === "retag" ? target : null, updated: 0, noOp: true };
  }

  const targetThreads = mismatches.map((mismatch) => mismatch.thread);
  assertThreadRolloutsInsideHome(home, targetThreads);
  const backupDir = await createBackup(home, safeMode === "repair" ? "config-sync:repair" : `config-sync:${target}`, targetThreads);
  try {
      const rolloutUpdates: JsonRecord[] = [];
    for (const mismatch of mismatches.filter((item) => item.needsRollout)) {
      const prepared = await prepareRolloutProviderUpdate(mismatch.thread.rollout_path, mismatch.targetProvider ?? target);
      if (!prepared.changed) {
        if (prepared.reason === "already-target") continue;
        throw new Error(`Cannot update rollout provider for ${mismatch.thread.id}: ${prepared.reason}`);
      }
      rolloutUpdates.push({ thread: mismatch.thread, ...prepared });
    }

    const db = openDb(home);
    let dbUpdated = 0;
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      let changes = 0;
      if (safeMode === "repair") {
        const updateThread = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?");
        for (const mismatch of mismatches.filter((item) => item.needsDb)) {
          changes += Number(updateThread.run(mismatch.targetProvider, mismatch.thread.id).changes ?? 0);
        }
      } else {
        changes = Number(db.prepare("UPDATE threads SET model_provider = ? WHERE model_provider <> ?").run(target, target).changes ?? 0);
      }
      db.exec("COMMIT");
      dbUpdated = changes;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    } finally {
      db.close();
    }

    for (const update of rolloutUpdates) {
      await writeFilePreservingTimes(update.thread.rollout_path, update.content);
    }
    return {
      dryRun: false,
      mode: safeMode,
      target: safeMode === "retag" ? target : null,
      updated: total,
      dbUpdated,
      rolloutUpdated: rolloutUpdates.length,
      groups,
      backupDir
    };
  } catch (error) {
    await restoreMutationBackup(home, backupDir);
    throw error;
  }
}

export {
  createProvider,
  deleteProfile,
  fixReservedProviders,
  getConfigOverview,
  getOfficialProviderFiles,
  readConfigFile,
  readProfileFile,
  saveProfile,
  switchProfile,
  syncProviderTag,
  useOfficialProvider,
  writeConfigFile,
  writeProfileFile
};
