import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const DB_NAME = "state_5.sqlite";
const GLOBAL_STATE = ".codex-global-state.json";
const BACKUP_ROOT = "backups_state/chat-manager";
const CONFIG_NAME = "config.toml";
const AUTH_NAME = "auth.json";
const PROFILE_DIR = "chat-manager-profiles";
const PROFILE_INDEX = "profiles.json";
const OFFICIAL_PROFILE_ID = "openai-official";
const OFFICIAL_PROFILE_LABEL = "OpenAI Official";
const AUTO_PROVIDER_PREFIX = "current-provider-";
const BUILTIN_PROVIDER_IDS = new Set(["openai"]);

function codexHome(flags) {
  return path.resolve(flags["codex-home"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function dbPath(home) {
  return path.join(home, DB_NAME);
}

function dbSidecarPaths(home) {
  const base = dbPath(home);
  return [`${base}-wal`, `${base}-shm`];
}

function globalStatePath(home) {
  return path.join(home, GLOBAL_STATE);
}

function backupRoot(home) {
  return path.join(home, BACKUP_ROOT);
}

function timestamp() {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "").replace("Z", "Z");
}

function normalizePathForCompare(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed).replace(/\/+$/, "").toLowerCase();
}

function isInsideDir(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeInside(parent, child) {
  if (!isInsideDir(parent, child)) {
    throw new Error(`Refusing to operate on rollout outside Codex home: ${child}`);
  }
  return path.relative(path.resolve(parent), path.resolve(child));
}

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function parseLimit(value, fallback = 50) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --limit: ${value}`);
  }
  return parsed;
}

function parsePort(value, fallback = 8765) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid --port: ${value}`);
  }
  return parsed;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function openDb(home, options = {}) {
  const db = new DatabaseSync(dbPath(home), options);
  // Tolerate Codex Desktop holding the DB: wait for the lock instead of failing.
  try {
    db.exec("PRAGMA busy_timeout = 4000");
  } catch {
    // Read-only or older builds may reject this; safe to ignore.
  }
  return db;
}

function getColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table.replaceAll("\"", "\"\"")}")`).all().map((row) => row.name));
}

function buildThreadQuery(flags) {
  const where = [];
  const params = {};

  if (!isTruthy(flags.all)) {
    if (isTruthy(flags.archived)) {
      where.push("archived = 1");
    } else {
      where.push("archived = 0");
    }
  } else if (isTruthy(flags.archived)) {
    where.push("archived = 1");
  }

  if (flags.provider) {
    where.push("model_provider = $provider");
    params.$provider = flags.provider;
  }

  const project = flags.project ?? flags.cwd;
  if (project) {
    where.push("cwd = $cwd");
    params.$cwd = path.resolve(project);
  }

  if (Array.isArray(flags.ids)) {
    const ids = flags.ids.filter(Boolean);
    if (!ids.length) return { sql: null, params: null, empty: true };
    where.push(`id IN (${ids.map((_, index) => `$id${index}`).join(", ")})`);
    ids.forEach((id, index) => {
      params[`$id${index}`] = id;
    });
  }

  const sql = `
    SELECT
      id, rollout_path, created_at, updated_at, source, thread_source,
      model_provider, cwd, title, archived, archived_at, has_user_event,
      first_user_message, preview
    FROM threads
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, id DESC
  `;
  return { sql, params };
}

function readThreads(home, flags = {}) {
  const db = openDb(home, { readOnly: true });
  try {
    const { sql, params, empty } = buildThreadQuery(flags);
    if (empty) return [];
    return db.prepare(sql).all(params);
  } finally {
    db.close();
  }
}

function readThreadById(home, id) {
  const db = openDb(home, { readOnly: true });
  try {
    return db.prepare(`
      SELECT *
      FROM threads
      WHERE id = ?
    `).get(id);
  } finally {
    db.close();
  }
}

function readThreadByRef(home, ref) {
  const exact = readThreadById(home, ref);
  if (exact) return exact;
  const matches = readThreads(home, { all: true }).filter((thread) => thread.id.startsWith(ref));
  if (matches.length > 1) {
    throw new Error(`Chat id prefix is ambiguous: ${ref}. Use a longer prefix.`);
  }
  return matches[0] ?? null;
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function savedProjectRoots(globalState) {
  const roots = [];
  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    const value = globalState?.[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) roots.push(entry);
    }
  }
  const seen = new Set();
  return roots.filter((root) => {
    const normalized = normalizePathForCompare(root);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function getProjects(home) {
  const globalState = await readJsonIfPresent(globalStatePath(home), {});
  const savedRoots = savedProjectRoots(globalState);
  const db = openDb(home, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT
        cwd,
        COUNT(*) AS total,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN archived = 0 AND has_user_event = 1 THEN 1 ELSE 0 END) AS interactive,
        MAX(updated_at) AS updated_at
      FROM threads
      GROUP BY cwd
      ORDER BY updated_at DESC, cwd
    `).all();
    const byPath = new Map();
    for (const root of savedRoots) {
      byPath.set(normalizePathForCompare(root), {
        path: root,
        saved: true,
        total: 0,
        active: 0,
        archived: 0,
        interactive: 0,
        updated_at: null
      });
    }
    for (const row of rows) {
      const key = normalizePathForCompare(row.cwd);
      const existing = byPath.get(key);
      if (!existing) continue;
      byPath.set(key, {
        path: existing?.path ?? row.cwd,
        saved: Boolean(existing?.saved),
        total: Number(row.total) || 0,
        active: Number(row.active) || 0,
        archived: Number(row.archived) || 0,
        interactive: Number(row.interactive) || 0,
        updated_at: row.updated_at ?? null
      });
    }
    return [...byPath.values()];
  } finally {
    db.close();
  }
}

async function getProjectlessThreadIds(home) {
  const globalState = await readJsonIfPresent(globalStatePath(home), {});
  return Array.isArray(globalState["projectless-thread-ids"])
    ? globalState["projectless-thread-ids"].filter((id) => typeof id === "string" && id)
    : [];
}

async function getProjectlessThreads(home, flags = {}) {
  const ids = await getProjectlessThreadIds(home);
  return readThreads(home, { ...flags, all: true, ids });
}

async function readRolloutMeta(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    let buffer = Buffer.alloc(64 * 1024);
    let collected = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      collected = Buffer.concat([collected, buffer.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        collected = collected.subarray(0, newlineIndex);
        break;
      }
      if (collected.length > 1024 * 1024) break;
    }
    const parsed = JSON.parse(collected.toString("utf8"));
    return parsed?.type === "session_meta" ? parsed.payload ?? {} : {};
  } finally {
    await handle.close();
  }
}

async function readRolloutFirstRecord(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const newlineIndex = raw.indexOf("\n");
  const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : raw.slice(newlineIndex);
  if (!firstLine.trim()) {
    return { raw, record: null, rest };
  }
  return { raw, record: JSON.parse(firstLine), rest };
}

async function prepareRolloutProviderUpdate(filePath, target) {
  const { raw, record, rest } = await readRolloutFirstRecord(filePath);
  if (record?.type !== "session_meta" || !record.payload || typeof record.payload !== "object") {
    return { changed: false, before: null, reason: "missing-session-meta" };
  }
  const before = record.payload.model_provider ?? null;
  if (before === target) {
    return { changed: false, before, reason: "already-target" };
  }
  record.payload.model_provider = target;
  const next = `${JSON.stringify(record)}${rest}`;
  return { changed: next !== raw, before, after: target, content: next };
}

async function scanRollouts(home) {
  const roots = [
    path.join(home, "sessions"),
    path.join(home, "archived_sessions")
  ];
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  for (const root of roots) await walk(root);
  const metas = [];
  for (const file of files) {
    try {
      const meta = await readRolloutMeta(file);
      metas.push({ path: file, id: meta.id, cwd: meta.cwd, model_provider: meta.model_provider });
    } catch (error) {
      metas.push({ path: file, error: error.message });
    }
  }
  return metas;
}

async function collectProviderTagMismatches(home, target, { strictRolloutPaths = false } = {}) {
  const threads = readThreads(home, { all: true });
  const mismatches = [];
  const groups = new Map();
  for (const thread of threads) {
    const needsDb = thread.model_provider !== target;
    let rolloutProvider = null;
    let needsRollout = false;
    let rolloutError = null;
    if (thread.rollout_path && await pathExists(thread.rollout_path)) {
      if (!isInsideDir(home, thread.rollout_path)) {
        if (strictRolloutPaths) relativeInside(home, thread.rollout_path);
        rolloutError = `Rollout is outside Codex home: ${thread.rollout_path}`;
      } else {
        try {
          const meta = await readRolloutMeta(thread.rollout_path);
          if (Object.keys(meta).length) {
            rolloutProvider = meta.model_provider ?? "(missing)";
            needsRollout = meta.model_provider !== target;
          }
        } catch (error) {
          rolloutError = error.message;
        }
      }
    }
    if (!needsDb && !needsRollout) continue;
    const provider = needsDb ? thread.model_provider : rolloutProvider;
    groups.set(provider, (groups.get(provider) ?? 0) + 1);
    mismatches.push({
      thread,
      provider,
      dbProvider: thread.model_provider,
      rolloutProvider,
      needsDb,
      needsRollout,
      rolloutError
    });
  }
  return {
    mismatches,
    groups: [...groups.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((left, right) => right.count - left.count || String(left.provider).localeCompare(String(right.provider)))
  };
}

async function collectProviderConsistencyMismatches(home, { strictRolloutPaths = false } = {}) {
  const threads = readThreads(home, { all: true });
  const mismatches = [];
  const groups = new Map();
  for (const thread of threads) {
    if (!thread.rollout_path || !(await pathExists(thread.rollout_path))) continue;
    if (!isInsideDir(home, thread.rollout_path)) {
      if (strictRolloutPaths) relativeInside(home, thread.rollout_path);
      continue;
    }
    let meta;
    try {
      meta = await readRolloutMeta(thread.rollout_path);
    } catch {
      continue;
    }
    if (!Object.keys(meta).length) continue;
    const rolloutProvider = meta.model_provider ?? null;
    if (rolloutProvider === thread.model_provider) continue;
    const targetProvider = rolloutProvider || thread.model_provider;
    const key = `${thread.model_provider || "(missing)"} -> ${targetProvider}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
    mismatches.push({
      thread,
      provider: thread.model_provider,
      dbProvider: thread.model_provider,
      rolloutProvider: rolloutProvider ?? "(missing)",
      targetProvider,
      needsDb: Boolean(rolloutProvider),
      needsRollout: !rolloutProvider
    });
  }
  return {
    mismatches,
    groups: [...groups.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((left, right) => right.count - left.count || String(left.provider).localeCompare(String(right.provider)))
  };
}

async function getStatus(home) {
  const db = openDb(home, { readOnly: true });
  let integrity = "unknown";
  let providerRows = [];
  let totals = {};
  try {
    integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    providerRows = db.prepare(`
      SELECT model_provider, archived, COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, model_provider
    `).all();
    totals = db.prepare(`
      SELECT
        COUNT(*) AS threads,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN has_user_event = 1 THEN 1 ELSE 0 END) AS interactive
      FROM threads
    `).get();
  } finally {
    db.close();
  }

  const rollouts = await scanRollouts(home);
  const dbThreads = readThreads(home, { all: true });
  const dbIds = new Set(dbThreads.map((thread) => thread.id));
  const fileIds = new Set(rollouts.filter((file) => file.id).map((file) => file.id));
  const missingRollout = dbThreads.filter((thread) => !fileIds.has(thread.id) || !thread.rollout_path);
  const missingDb = rollouts.filter((file) => file.id && !dbIds.has(file.id));
  const rolloutPathOutsideHome = dbThreads.filter((thread) => thread.rollout_path && !isInsideDir(home, thread.rollout_path));
  const rolloutProviderCounts = {};
  for (const rollout of rollouts) {
    const provider = rollout.model_provider || "(missing)";
    rolloutProviderCounts[provider] = (rolloutProviderCounts[provider] ?? 0) + 1;
  }
  const projectlessThreadIds = await getProjectlessThreadIds(home);
  const activeProvider = summarizeConfig(await readTextIfPresent(configPath(home), "") ?? "").modelProvider;
  const providerSync = activeProvider
    ? await collectProviderTagMismatches(home, activeProvider)
    : { mismatches: [], groups: [] };
  const providerRepair = await collectProviderConsistencyMismatches(home);

  return {
    codexHome: home,
    integrity,
    totals,
    sqliteProviders: providerRows,
    rolloutFiles: rollouts.length,
    projectlessCount: projectlessThreadIds.length,
    projectlessThreadIds,
    rolloutProviders: rolloutProviderCounts,
    missingRolloutCount: missingRollout.length,
    missingDbCount: missingDb.length,
    rolloutPathOutsideHomeCount: rolloutPathOutsideHome.length,
    activeProvider: activeProvider ?? null,
    providerSyncMismatchCount: providerSync.mismatches.length,
    providerSyncMismatchGroups: providerSync.groups,
    providerRepairMismatchCount: providerRepair.mismatches.length,
    providerRepairMismatchGroups: providerRepair.groups,
    missingRollout,
    missingDb,
    rolloutPathOutsideHome
  };
}

async function createBackup(home, reason, targetThreads = []) {
  const dir = path.join(backupRoot(home), timestamp());
  await fs.mkdir(path.join(dir, "db"), { recursive: true });
  await fs.mkdir(path.join(dir, "rollouts"), { recursive: true });
  const statePath = dbPath(home);
  try {
    await execFileAsync("sqlite3", [statePath, `.backup '${path.join(dir, "db", DB_NAME).replaceAll("'", "''")}'`]);
  } catch {
    await fs.copyFile(statePath, path.join(dir, "db", DB_NAME));
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${statePath}${suffix}`;
      if (await pathExists(sidecar)) {
        await fs.copyFile(sidecar, path.join(dir, "db", `${DB_NAME}${suffix}`));
      }
    }
  }
  for (const file of [globalStatePath(home), `${globalStatePath(home)}.bak`, configPath(home), authPath(home)]) {
    if (await pathExists(file)) {
      await fs.copyFile(file, path.join(dir, path.basename(file)));
    }
  }
  const copiedRollouts = [];
  for (const thread of targetThreads) {
    if (!thread?.rollout_path || !(await pathExists(thread.rollout_path))) continue;
    const destination = path.join(dir, "rollouts", `${thread.id}-${path.basename(thread.rollout_path)}`);
    await fs.copyFile(thread.rollout_path, destination);
    copiedRollouts.push({ id: thread.id, originalPath: thread.rollout_path, backupPath: destination });
  }
  const metadata = {
    version: 1,
    createdAt: new Date().toISOString(),
    reason,
    codexHome: home,
    threadIds: targetThreads.map((thread) => thread.id),
    copiedRollouts
  };
  await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  return dir;
}

async function restoreDbFilesFromBackup(home, backupDir) {
  const backupDb = path.join(backupDir, "db", DB_NAME);
  if (!(await pathExists(backupDb))) return false;
  for (const sidecar of dbSidecarPaths(home)) {
    await fs.rm(sidecar, { force: true });
  }
  await fs.copyFile(backupDb, dbPath(home));
  for (const suffix of ["-wal", "-shm"]) {
    const backupSidecar = path.join(backupDir, "db", `${DB_NAME}${suffix}`);
    if (await pathExists(backupSidecar)) {
      await fs.copyFile(backupSidecar, `${dbPath(home)}${suffix}`);
    }
  }
  return true;
}

async function restoreMutableFilesFromBackup(home, backupDir) {
  for (const name of [GLOBAL_STATE, `${GLOBAL_STATE}.bak`, CONFIG_NAME, AUTH_NAME]) {
    const file = path.join(backupDir, name);
    if (await pathExists(file)) {
      await fs.copyFile(file, path.join(home, name));
    }
  }
}

async function restoreCopiedRolloutsFromBackup(backupDir) {
  const metadata = await readJsonIfPresent(path.join(backupDir, "metadata.json"), null);
  let restored = 0;
  for (const rollout of metadata?.copiedRollouts ?? []) {
    if (!rollout?.backupPath || !rollout?.originalPath || !(await pathExists(rollout.backupPath))) continue;
    await fs.mkdir(path.dirname(rollout.originalPath), { recursive: true });
    await fs.copyFile(rollout.backupPath, rollout.originalPath);
    restored += 1;
  }
  return restored;
}

async function restoreMutationBackup(home, backupDir) {
  await restoreDbFilesFromBackup(home, backupDir);
  await restoreMutableFilesFromBackup(home, backupDir);
  const restoredRollouts = await restoreCopiedRolloutsFromBackup(backupDir);
  return { restoredRollouts };
}

async function listBackups(home) {
  let entries = [];
  try {
    entries = await fs.readdir(backupRoot(home), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupPath = path.join(backupRoot(home), entry.name);
    let metadata = null;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(backupPath, "metadata.json"), "utf8"));
    } catch {
      metadata = null;
    }
    const stat = await fs.stat(backupPath);
    backups.push({
      name: entry.name,
      path: backupPath,
      createdAt: metadata?.createdAt ?? stat.mtime.toISOString(),
      reason: metadata?.reason ?? "",
      threadIds: metadata?.threadIds ?? [],
      codexHome: metadata?.codexHome ?? home
    });
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function resolveProjectRef(home, ref) {
  if (!String(ref).startsWith("#")) return ref;
  const index = Number.parseInt(String(ref).slice(1), 10);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid project number: ${ref}`);
  }
  const projects = await getProjects(home);
  const project = projects[index - 1];
  if (!project) {
    throw new Error(`Project number not found: ${ref}`);
  }
  return project.path;
}

async function resolveBackupRef(home, ref) {
  if (!String(ref).startsWith("#")) return ref;
  const index = Number.parseInt(String(ref).slice(1), 10);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid backup number: ${ref}`);
  }
  const backups = await listBackups(home);
  const backup = backups[index - 1];
  if (!backup) {
    throw new Error(`Backup number not found: ${ref}`);
  }
  return backup.path;
}

function removeThreadRefsFromGlobalState(state, ids) {
  const idSet = new Set(ids);
  const arrayKeys = ["projectless-thread-ids", "pinned-thread-ids"];
  for (const key of arrayKeys) {
    if (Array.isArray(state[key])) {
      state[key] = state[key].filter((id) => !idSet.has(id));
    }
  }
  const objectKeys = [
    "thread-workspace-root-hints",
    "thread-projectless-output-directories"
  ];
  const persisted = state["electron-persisted-atom-state"];
  if (persisted && typeof persisted === "object") {
    objectKeys.push("heartbeat-thread-permissions-by-id");
    if (persisted["unread-thread-ids-by-host-v1"] && typeof persisted["unread-thread-ids-by-host-v1"] === "object") {
      for (const [host, values] of Object.entries(persisted["unread-thread-ids-by-host-v1"])) {
        if (Array.isArray(values)) {
          persisted["unread-thread-ids-by-host-v1"][host] = values.filter((id) => !idSet.has(id));
        }
      }
    }
  }
  for (const key of objectKeys) {
    const holder = key === "heartbeat-thread-permissions-by-id" ? persisted : state;
    if (holder?.[key] && typeof holder[key] === "object" && !Array.isArray(holder[key])) {
      for (const id of idSet) delete holder[key][id];
    }
  }
}

function removeProjectRootFromGlobalState(state, projectPath) {
  const target = normalizePathForCompare(projectPath);
  let removed = 0;
  for (const key of ["electron-saved-workspace-roots", "project-order", "active-workspace-roots"]) {
    if (!Array.isArray(state[key])) continue;
    const before = state[key].length;
    state[key] = state[key].filter((entry) => normalizePathForCompare(entry) !== target);
    removed += before - state[key].length;
  }
  return removed;
}

function countProjectRootRefs(state, projectPath) {
  const target = normalizePathForCompare(projectPath);
  let count = 0;
  for (const key of ["electron-saved-workspace-roots", "project-order", "active-workspace-roots"]) {
    if (!Array.isArray(state[key])) continue;
    count += state[key].filter((entry) => normalizePathForCompare(entry) === target).length;
  }
  return count;
}

function assertThreadRolloutsInsideHome(home, threads) {
  for (const thread of threads) {
    if (thread.rollout_path) {
      relativeInside(home, thread.rollout_path);
    }
  }
}

async function writeGlobalState(home, state) {
  await fs.writeFile(globalStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

async function trashThreads(home, threads, { execute, reason, backupDir: existingBackupDir = null }) {
  if (!threads.length) {
    return { dryRun: !execute, backupDir: null, trashed: 0, threads: [] };
  }
  if (!execute) {
    return { dryRun: true, backupDir: null, trashed: 0, threads };
  }

  assertThreadRolloutsInsideHome(home, threads);

  const backupDir = existingBackupDir ?? await createBackup(home, reason, threads);
  try {
    const trashRoot = path.join(backupDir, "trash");
    await fs.mkdir(trashRoot, { recursive: true });
    const moved = [];
    for (const thread of threads) {
      if (!thread.rollout_path || !(await pathExists(thread.rollout_path))) continue;
      const relative = relativeInside(home, thread.rollout_path);
      const destination = path.join(trashRoot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(thread.rollout_path, destination);
      moved.push({ id: thread.id, from: thread.rollout_path, to: destination });
    }

    const db = openDb(home);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("BEGIN IMMEDIATE");
      const ids = threads.map((thread) => thread.id);
      const deleteDynamic = db.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?");
      const deleteSpawnParent = db.prepare("DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?");
      const deleteSpawnChild = db.prepare("DELETE FROM thread_spawn_edges WHERE child_thread_id = ?");
      const clearJobs = db.prepare("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?");
      const deleteThread = db.prepare("DELETE FROM threads WHERE id = ?");
      for (const id of ids) {
        deleteDynamic.run(id);
        deleteSpawnParent.run(id);
        deleteSpawnChild.run(id);
        clearJobs.run(id);
        deleteThread.run(id);
      }
      db.exec("COMMIT");
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

    const state = await readJsonIfPresent(globalStatePath(home), {});
    removeThreadRefsFromGlobalState(state, threads.map((thread) => thread.id));
    await writeGlobalState(home, state);
    await fs.writeFile(path.join(backupDir, "trash-manifest.json"), JSON.stringify({ moved }, null, 2));
    return { dryRun: false, backupDir, trashed: threads.length, threads, moved };
  } catch (error) {
    await restoreMutationBackup(home, backupDir);
    throw error;
  }
}

async function deleteProject(home, projectPath, { execute }) {
  const normalizedProject = path.resolve(projectPath);
  const target = normalizePathForCompare(normalizedProject);
  const threads = readThreads(home, { all: true }).filter((thread) => normalizePathForCompare(thread.cwd) === target);
  const state = await readJsonIfPresent(globalStatePath(home), {});
  const projectRootRefs = countProjectRootRefs(state, normalizedProject);
  if (!execute) {
    return {
      dryRun: true,
      project: normalizedProject,
      deletesChats: true,
      projectRootRefs,
      matchingThreadCount: threads.length,
      matchingThreads: threads
    };
  }

  if (!threads.length && projectRootRefs === 0) {
    return {
      dryRun: false,
      project: normalizedProject,
      backupDir: null,
      removedProjectRefs: 0,
      trashed: 0,
      noOp: true
    };
  }

  assertThreadRolloutsInsideHome(home, threads);
  const backupDir = await createBackup(home, `delete-project:${normalizedProject}`, threads);
  const removedProjectRefs = removeProjectRootFromGlobalState(state, normalizedProject);
  await writeGlobalState(home, state);
  let trashResult = { trashed: 0, moved: [] };
  if (threads.length) {
    trashResult = await trashThreads(home, threads, {
      execute: true,
      reason: `delete-project-threads:${normalizedProject}`,
      backupDir
    });
  }
  return {
    dryRun: false,
    project: normalizedProject,
    backupDir,
    removedProjectRefs,
    deletesChats: true,
    trashed: trashResult.trashed,
    matchingThreadCount: threads.length,
    threadBackupDir: trashResult.backupDir
  };
}

async function restoreBackup(home, backupDir, execute) {
  const source = path.resolve(backupDir);
  const metadata = await readJsonIfPresent(path.join(source, "metadata.json"), null);
  if (!metadata) {
    throw new Error(`Not a codex-chat-manager backup: ${source}`);
  }
  if (!execute) {
    return { dryRun: true, backupDir: source, metadata };
  }

  const backupBeforeRestore = await createBackup(home, `pre-restore:${source}`, []);
  await restoreDbFilesFromBackup(home, source);
  await restoreMutableFilesFromBackup(home, source);
  const trashRoot = path.join(source, "trash");
  async function restoreTrash(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let restored = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        restored += await restoreTrash(full);
      } else if (entry.isFile()) {
        const relative = path.relative(trashRoot, full);
        const destination = path.join(home, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(full, destination);
        restored += 1;
      }
    }
    return restored;
  }
  const restoredFiles = await restoreTrash(trashRoot);
  return { dryRun: false, backupDir: source, preRestoreBackup: backupBeforeRestore, restoredFiles };
}

// --- Config / provider switching ----------------------------------------

function configPath(home) {
  return path.join(home, CONFIG_NAME);
}

function authPath(home) {
  return path.join(home, AUTH_NAME);
}

function profileDir(home) {
  return path.join(home, PROFILE_DIR);
}

function profileIndexPath(home) {
  return path.join(profileDir(home), PROFILE_INDEX);
}

async function readTextIfPresent(filePath, fallback = null) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeTextIfChanged(filePath, content) {
  const current = await readTextIfPresent(filePath, null);
  if (current === content) return false;
  await fs.writeFile(filePath, content);
  return true;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskToken(value) {
  const text = String(value ?? "");
  if (text.length <= 12) return text ? "****" : "";
  return `${text.slice(0, 7)}…${text.slice(-4)}`;
}

function parseTomlScalar(raw) {
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function formatTomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function isTableHeader(line) {
  return /^\s*\[/.test(line);
}

function tableHeaderName(line) {
  const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
  return match ? match[1].trim() : null;
}

function providerKeyFromHeader(header) {
  const match = header.match(/^model_providers\.(.+)$/);
  if (!match) return null;
  let key = match[1].trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  return key;
}

function topLevelRange(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (isTableHeader(lines[i])) return [0, i];
  }
  return [0, lines.length];
}

function providerRange(lines, key) {
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

function readScalarInRange(lines, start, end, key) {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = start; i < end; i += 1) {
    const match = lines[i].match(re);
    if (match) return parseTomlScalar(match[1]);
  }
  return undefined;
}

function setScalarInRange(lines, start, end, key, value, insertAt) {
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

function setOfficialProviderInText(text) {
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

function summarizeConfig(text) {
  const lines = text.split("\n");
  const [topStart, topEnd] = topLevelRange(lines);
  const model = readScalarInRange(lines, topStart, topEnd, "model");
  const configuredModelProvider = readScalarInRange(lines, topStart, topEnd, "model_provider");
  const modelProvider = configuredModelProvider ?? "openai";
  const bearer = readScalarInRange(lines, topStart, topEnd, "experimental_bearer_token");
  let provider = null;
  if (modelProvider) {
    const range = providerRange(lines, modelProvider);
    if (range) {
      const [ps, pe] = range;
      provider = {
        key: modelProvider,
        name: readScalarInRange(lines, ps, pe, "name") ?? null,
        baseUrl: readScalarInRange(lines, ps, pe, "base_url") ?? null,
        wireApi: readScalarInRange(lines, ps, pe, "wire_api") ?? null,
        requiresOpenaiAuth: readScalarInRange(lines, ps, pe, "requires_openai_auth") ?? null,
        envKey: readScalarInRange(lines, ps, pe, "env_key") ?? null
      };
    }
  }
  return {
    model: model ?? null,
    modelProvider,
    configuredModelProvider: configuredModelProvider ?? null,
    provider,
    bearer: bearer
      ? { present: true, masked: maskToken(bearer), value: String(bearer) }
      : { present: false, masked: "", value: "" }
  };
}

function providerKind(provider, modelProvider) {
  // Any explicit [model_providers.<id>] block is a custom provider, even if it reuses a built-in id.
  if (provider) return "third-party";
  // No custom block: a built-in id (e.g. openai) means the official, auth-based provider.
  if (modelProvider && BUILTIN_PROVIDER_IDS.has(modelProvider)) return "official";
  return "unknown";
}

function isReservedProviderId(id) {
  return BUILTIN_PROVIDER_IDS.has(id);
}

function findReservedProviderBlocks(text) {
  const found = [];
  for (const id of BUILTIN_PROVIDER_IDS) {
    const re = new RegExp(`^\\s*\\[model_providers\\.(?:"${escapeRegex(id)}"|${escapeRegex(id)})\\]`, "m");
    if (re.test(text)) found.push(id);
  }
  return found;
}

function assertNoReservedProviderBlock(text) {
  for (const id of BUILTIN_PROVIDER_IDS) {
    const re = new RegExp(`^\\s*\\[model_providers\\.(?:"${escapeRegex(id)}"|${escapeRegex(id)})\\]`, "m");
    if (re.test(text)) {
      throw new Error(`config.toml defines [model_providers.${id}], but "${id}" is a reserved built-in provider that cannot be overridden. Rename it to a custom id.`);
    }
  }
}


async function readAuthSummary(home) {
  const auth = await readJsonIfPresent(authPath(home), null);
  if (!auth) return { exists: false, mode: null, hasApiKey: false, apiKey: null };
  return {
    exists: true,
    mode: auth.auth_mode ?? null,
    hasApiKey: Boolean(auth.OPENAI_API_KEY),
    apiKey: auth.OPENAI_API_KEY ?? null
  };
}

function isOfficialAuthText(raw) {
  if (!raw) return false;
  try {
    const auth = JSON.parse(raw);
    return Boolean(auth?.auth_mode) && !auth.OPENAI_API_KEY;
  } catch {
    return false;
  }
}

async function readCurrentOfficialAuthText(home) {
  const authText = await readTextIfPresent(authPath(home), null);
  return isOfficialAuthText(authText) ? authText : null;
}

function officialProfileConfigPath(home) {
  return path.join(profileDir(home), `${OFFICIAL_PROFILE_ID}.toml`);
}

function officialProfileAuthPath(home) {
  return path.join(profileDir(home), `${OFFICIAL_PROFILE_ID}.auth.json`);
}

function currentProviderProfileId(providerId) {
  const safe = String(providerId ?? "custom").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${AUTO_PROVIDER_PREFIX}${safe || "custom"}`;
}

function upsertProfile(profiles, entry) {
  const existing = profiles.find((profile) => profile.id === entry.id);
  return existing
    ? profiles.map((profile) => (profile.id === entry.id ? { ...profile, ...entry, createdAt: profile.createdAt ?? entry.createdAt } : profile))
    : [...profiles, entry];
}

async function ensureOfficialProviderSnapshot(home) {
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

async function ensureCurrentThirdPartyProvider(home, configText, authText, summary) {
  if (!summary.modelProvider || providerKind(summary.provider, summary.modelProvider) !== "third-party") {
    return { saved: false, reason: "not-third-party" };
  }
  const id = currentProviderProfileId(summary.modelProvider);
  const configFile = path.join(profileDir(home), `${id}.toml`);
  const authFile = path.join(profileDir(home), `${id}.auth.json`);
  await fs.mkdir(profileDir(home), { recursive: true });
  const normalizedConfig = configText.endsWith("\n") ? configText : `${configText}\n`;
  const wroteConfig = await writeTextIfChanged(configFile, normalizedConfig);
  let wroteAuth = false;
  if (authText !== null) {
    const normalizedAuth = authText.endsWith("\n") ? authText : `${authText}\n`;
    wroteAuth = await writeTextIfChanged(authFile, normalizedAuth);
  } else if (await pathExists(authFile)) {
    await fs.rm(authFile, { force: true });
    wroteAuth = true;
  }

  const now = new Date().toISOString();
  const profiles = await readProfileIndex(home);
  const existing = profiles.find((profile) => profile.id === id);
  const entry = {
    ...(existing ?? {}),
    id,
    label: summary.provider?.name ?? summary.modelProvider,
    note: "Detected from current Codex config.",
    kind: "third-party",
    hasAuth: authText !== null,
    autoDetected: true,
    providerId: summary.modelProvider,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now
  };
  await writeProfileIndex(home, upsertProfile(profiles, entry));
  return { saved: wroteConfig || wroteAuth || !existing, profile: entry, wroteConfig, wroteAuth };
}

async function reconcileCurrentProvider(home) {
  const configText = await readTextIfPresent(configPath(home), "") ?? "";
  const authText = await readTextIfPresent(authPath(home), null);
  const summary = summarizeConfig(configText);
  const kind = providerKind(summary.provider, summary.modelProvider);
  if (kind === "official" && isOfficialAuthText(authText)) {
    return { kind, official: await ensureOfficialProviderSnapshot(home), thirdParty: { saved: false, reason: "not-third-party" } };
  }
  if (kind === "third-party") {
    return {
      kind,
      official: { saved: false, reason: "not-official-config" },
      thirdParty: await ensureCurrentThirdPartyProvider(home, configText, authText, summary)
    };
  }
  return {
    kind,
    official: { saved: false, reason: "not-official" },
    thirdParty: { saved: false, reason: "not-third-party" }
  };
}

async function findOfficialAuthSnapshot(home) {
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

async function findOfficialBackupSnapshot(home) {
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

function officialProfileInfo(snapshot) {
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

function officialBackupInfo(snapshot, currentOfficialAuthText = null) {
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

async function resolveOfficialProviderSource(home) {
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

function publicOfficialSourceInfo(source) {
  const { configText, authText, ...info } = source;
  return info;
}

async function getOfficialProviderFiles(home) {
  await reconcileCurrentProvider(home);
  const source = await resolveOfficialProviderSource(home);
  return {
    ...source,
    config: source.configText ?? "",
    auth: source.authText ?? "",
    missing: !source.available
  };
}

function configFilePath(home, file) {
  if (file === "auth") return authPath(home);
  if (file === "config" || file === undefined) return configPath(home);
  throw new Error(`Unknown file "${file}"; use config or auth`);
}

async function readConfigFile(home, file) {
  const filePath = configFilePath(home, file);
  const raw = await readTextIfPresent(filePath, null);
  return { file: file ?? "config", path: filePath, exists: raw !== null, raw: raw ?? "" };
}

async function writeConfigFile(home, file, content, { execute }) {
  const filePath = configFilePath(home, file);
  if (file === "auth") {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`Refusing to save: auth.json is not valid JSON (${error.message})`);
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

function assertProfileId(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid profile id: ${id || "(empty)"}`);
  }
  return id;
}

async function requireProfile(home, profileId) {
  const id = assertProfileId(profileId);
  const entry = (await readProfileIndex(home)).find((profile) => profile.id === id);
  if (!entry) throw new Error(`Profile not found: ${id}`);
  return entry;
}

async function readProfileFile(home, profileId, file = "config") {
  const entry = await requireProfile(home, profileId);
  const safeFile = file === "auth" ? "auth" : "config";
  const filePath = path.join(profileDir(home), `${entry.id}.${safeFile === "auth" ? "auth.json" : "toml"}`);
  const raw = await readTextIfPresent(filePath, null);
  return { profileId: entry.id, file: safeFile, path: filePath, exists: raw !== null, raw: raw ?? "" };
}

async function writeProfileFile(home, profileId, file, content, { execute }) {
  const entry = await requireProfile(home, profileId);
  const safeFile = file === "auth" ? "auth" : "config";
  if (typeof content !== "string") throw new Error("content is required");
  if (safeFile === "auth") {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
  } else {
    assertNoReservedProviderBlock(content);
  }
  const filePath = path.join(profileDir(home), `${entry.id}.${safeFile === "auth" ? "auth.json" : "toml"}`);
  if (!execute) {
    return { dryRun: true, file: safeFile, path: filePath, bytes: Buffer.byteLength(content, "utf8") };
  }
  await fs.writeFile(filePath, content);
  if (safeFile === "auth" && entry.hasAuth !== true) {
    const profiles = await readProfileIndex(home);
    await writeProfileIndex(home, profiles.map((profile) => (
      profile.id === entry.id ? { ...profile, hasAuth: true } : profile
    )));
  }
  return { dryRun: false, file: safeFile, path: filePath, saved: true };
}

async function readProfileIndex(home) {
  const index = await readJsonIfPresent(profileIndexPath(home), null);
  return Array.isArray(index?.profiles) ? index.profiles : [];
}

async function writeProfileIndex(home, profiles) {
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(profileIndexPath(home), `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
}

async function listProfiles(home, currentText) {
  const entries = await readProfileIndex(home);
  const profiles = [];
  for (const entry of entries) {
    if (entry.autoManaged === true && entry.id === OFFICIAL_PROFILE_ID) continue;
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
      providerId: entry.providerId ?? null,
      missing: snapshot === null,
      hasAuth: entry.hasAuth === true,
      active: snapshot !== null && snapshot === currentText
    });
  }
  return profiles.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function getConfigOverview(home) {
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

async function saveProfile(home, { label, note = "", kind }) {
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
    hasAuth,
    createdAt: new Date().toISOString()
  };
  profiles.push(entry);
  await writeProfileIndex(home, profiles);
  return { saved: true, profile: entry };
}

async function createProvider(home, {
  label,
  providerId,
  configText,
  authText,
  switch: shouldSwitch = false
}) {
  const safeLabel = String(label ?? "").trim();
  const safeProviderId = String(providerId ?? "").trim();
  if (!safeLabel) throw new Error("label is required");
  if (!safeProviderId) throw new Error("providerId is required");
  if (!/^[A-Za-z0-9._-]+$/.test(safeProviderId)) {
    throw new Error("providerId may only contain letters, numbers, dot, underscore, and hyphen");
  }
  if (isReservedProviderId(safeProviderId)) {
    throw new Error(`"${safeProviderId}" is a reserved built-in provider. Use a custom id like "openai-custom".`);
  }

  if (typeof configText !== "string" || !configText.trim()) {
    throw new Error("configText is required");
  }
  assertNoReservedProviderBlock(configText);

  let normalizedAuthText = null;
  if (typeof authText === "string" && authText.trim()) {
    try {
      JSON.parse(authText);
    } catch (error) {
      throw new Error(`authText is not valid JSON (${error.message})`);
    }
    normalizedAuthText = authText.endsWith("\n") ? authText : `${authText}\n`;
  }
  const result = await saveProfileFromText(home, {
    label: safeLabel,
    note: "",
    kind: "third-party",
    configText: configText.endsWith("\n") ? configText : `${configText}\n`,
    authText: normalizedAuthText
  });
  if (shouldSwitch) {
    await switchProfile(home, result.profile.id, { execute: true });
  }
  return { saved: true, profile: result.profile, switched: Boolean(shouldSwitch) };
}

async function saveProfileFromText(home, { label, note = "", kind = "custom", configText, authText = null }) {
  const id = `${timestamp()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(path.join(profileDir(home), `${id}.toml`), configText);
  const hasAuth = authText !== null;
  if (hasAuth) {
    await fs.writeFile(path.join(profileDir(home), `${id}.auth.json`), authText);
  }
  const profiles = await readProfileIndex(home);
  const entry = {
    id,
    label,
    note,
    kind,
    hasAuth,
    createdAt: new Date().toISOString()
  };
  profiles.push(entry);
  await writeProfileIndex(home, profiles);
  return { saved: true, profile: entry };
}

async function useOfficialProvider(home, { execute }) {
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

async function deleteProfile(home, id, { execute }) {
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

async function switchProfile(home, profileId, { execute }) {
  const entry = (await readProfileIndex(home)).find((p) => p.id === profileId);
  if (!entry) throw new Error(`Profile not found: ${profileId}`);
  const configSnapshot = await readTextIfPresent(path.join(profileDir(home), `${profileId}.toml`), null);
  if (configSnapshot === null) throw new Error(`Profile config missing: ${profileId}`);
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

function renameProviderInText(text, fromId, toId) {
  const lines = text.split("\n");
  const changes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = tableHeaderName(lines[i]);
    if (header && providerKeyFromHeader(header) === fromId) {
      lines[i] = lines[i].replace(/\[model_providers\..*\]/, `[model_providers.${toId}]`);
      changes.push({ scope: "block", key: "header", before: fromId, after: toId });
      // Rename the block's name field if it echoed the old id.
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isTableHeader(lines[j])) { end = j; break; }
      }
      if (readScalarInRange(lines, i + 1, end, "name") === fromId) {
        setScalarInRange(lines, i + 1, end, "name", toId, i + 1);
      }
    }
  }
  const [ts, te] = topLevelRange(lines);
  if (readScalarInRange(lines, ts, te, "model_provider") === fromId) {
    setScalarInRange(lines, ts, te, "model_provider", toId, te);
    changes.push({ scope: "top", key: "model_provider", before: fromId, after: toId });
  }
  return { text: lines.join("\n"), changes };
}

async function fixReservedProviders(home, { toId = "openai-custom", execute }) {
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

async function syncProviderTag(home, { toId, execute, mode = "retag" }) {
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  const target = (toId && String(toId).trim()) || summarizeConfig(text).modelProvider;
  const safeMode = mode === "repair" ? "repair" : "retag";
  if (safeMode === "retag" && !target) {
    throw new Error("No target provider id; set model_provider in config.toml or pass --to <id>");
  }
  const { mismatches, groups } = safeMode === "repair"
    ? await collectProviderConsistencyMismatches(home, { strictRolloutPaths: true })
    : await collectProviderTagMismatches(home, target, { strictRolloutPaths: true });
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
    const rolloutUpdates = [];
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
      await fs.writeFile(update.thread.rollout_path, update.content);
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
  codexHome,
  dbPath,
  globalStatePath,
  backupRoot,
  normalizePathForCompare,
  isInsideDir,
  relativeInside,
  isTruthy,
  parseLimit,
  parsePort,
  pathExists,
  openDb,
  readThreads,
  readThreadById,
  readThreadByRef,
  getProjectlessThreadIds,
  getProjectlessThreads,
  readJsonIfPresent,
  getProjects,
  scanRollouts,
  getStatus,
  createBackup,
  listBackups,
  resolveProjectRef,
  resolveBackupRef,
  trashThreads,
  deleteProject,
  restoreBackup,
  configPath,
  authPath,
  profileDir,
  profileIndexPath,
  summarizeConfig,
  providerKind,
  isReservedProviderId,
  findReservedProviderBlocks,
  assertNoReservedProviderBlock,
  readAuthSummary,
  ensureOfficialProviderSnapshot,
  readConfigFile,
  writeConfigFile,
  assertProfileId,
  requireProfile,
  readProfileFile,
  writeProfileFile,
  readProfileIndex,
  writeProfileIndex,
  listProfiles,
  getConfigOverview,
  getOfficialProviderFiles,
  saveProfile,
  saveProfileFromText,
  createProvider,
  useOfficialProvider,
  deleteProfile,
  switchProfile,
  renameProviderInText,
  fixReservedProviders,
  syncProviderTag
};
