import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readTextIfPresent } from "./io.js";
import { summarizeConfig } from "./config-text.js";
import type { BackupFiles, BackupScope, BackupSummary, Project, Status, Thread, JsonRecord } from "../types.js";

const execFileAsync = promisify(execFile);
const DB_NAME = "state_5.sqlite";
const GLOBAL_STATE = ".codex-global-state.json";
const BACKUP_ROOT = "backups_state/chat-manager";
const CONFIG_NAME = "config.toml";
const AUTH_NAME = "auth.json";

type CliFlags = Record<string, any> & {
  ids?: string[];
  all?: unknown;
  cwd?: string;
};
type BackupClassification = {
  category: string;
  kind: string;
  title: string;
  subject: string;
  scopes: BackupScope[];
};

function codexHome(flags: CliFlags): string {
  return path.resolve(flags["codex-home"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function dbPath(home: string): string {
  return path.join(home, DB_NAME);
}

function dbSidecarPaths(home: string): string[] {
  const base = dbPath(home);
  return [`${base}-wal`, `${base}-shm`];
}

function globalStatePath(home: string): string {
  return path.join(home, GLOBAL_STATE);
}

function backupRoot(home: string): string {
  return path.join(home, BACKUP_ROOT);
}

function configPath(home: string): string {
  return path.join(home, CONFIG_NAME);
}

function authPath(home: string): string {
  return path.join(home, AUTH_NAME);
}

function timestamp(): string {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "").replace("Z", "Z");
}

function normalizePathForCompare(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed).replace(/\/+$/, "").toLowerCase();
}

function isInsideDir(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeInside(parent: string, child: string): string {
  if (!isInsideDir(parent, child)) {
    throw new Error(`Refusing to operate on rollout outside Codex home: ${child}`);
  }
  return path.relative(path.resolve(parent), path.resolve(child));
}

function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function parseLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --limit: ${value}`);
  }
  return parsed;
}

function parsePort(value: unknown, fallback = 8765): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid --port: ${value}`);
  }
  return parsed;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFilePreservingTimes(filePath: string, content: string): Promise<void> {
  const stat = await fs.stat(filePath);
  await fs.writeFile(filePath, content);
  await fs.utimes(filePath, stat.atime, stat.mtime);
}

function openDb(home: string, options: any = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath(home), options);
  // Tolerate Codex Desktop holding the DB: wait for the lock instead of failing.
  try {
    db.exec("PRAGMA busy_timeout = 4000");
  } catch {
    // Read-only or older builds may reject this; safe to ignore.
  }
  return db;
}

function getColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table.replaceAll("\"", "\"\"")}")`).all() as JsonRecord[]).map((row) => String(row.name)));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function quoteIdent(value: string): string {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

function sqlString(value: string): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}

function attachedTableColumns(db: DatabaseSync, alias: string, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA ${quoteIdent(alias)}.table_info(${quoteIdent(table)})`).all() as JsonRecord[]).map((row) => String(row.name)));
}

function uniqueStrings(values: unknown): string[] {
  const array = Array.isArray(values) ? values : [];
  return [...new Set(array.filter((value) => typeof value === "string" && value))];
}

function compactThreadSummary(thread: Thread): Thread {
  return {
    id: thread.id,
    title: thread.title ?? "",
    cwd: thread.cwd ?? "",
    model_provider: thread.model_provider ?? "",
    updated_at: thread.updated_at ?? null,
    created_at: thread.created_at ?? null,
    preview: thread.preview ?? thread.first_user_message ?? "",
    first_user_message: thread.first_user_message ?? "",
    rollout_path: thread.rollout_path ?? "",
    archived: Number(thread.archived ?? 0)
  };
}

function buildThreadQuery(flags: CliFlags): { sql: string | null; params: JsonRecord | null; empty?: boolean } {
  const where: string[] = [];
  const params: JsonRecord = {};

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

function readThreads(home: string, flags: CliFlags = {}): Thread[] {
  const db = openDb(home, { readOnly: true });
  try {
    const { sql, params, empty } = buildThreadQuery(flags);
    if (empty) return [];
    if (!sql) return [];
    return db.prepare(sql).all((params ?? {}) as any) as Thread[];
  } finally {
    db.close();
  }
}

function readThreadById(home: string, id: string): Thread | undefined {
  const db = openDb(home, { readOnly: true });
  try {
    return db.prepare(`
      SELECT *
      FROM threads
      WHERE id = ?
    `).get(id) as Thread | undefined;
  } finally {
    db.close();
  }
}

function readThreadByRef(home: string, ref: string): Thread | null {
  const exact = readThreadById(home, ref);
  if (exact) return exact;
  const matches = readThreads(home, { all: true }).filter((thread) => thread.id.startsWith(ref));
  if (matches.length > 1) {
    throw new Error(`Chat id prefix is ambiguous: ${ref}. Use a longer prefix.`);
  }
  return matches[0] ?? null;
}

async function readJsonIfPresent<T>(filePath: string, fallback: T): Promise<any | T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    throw error;
  }
}

function savedProjectRoots(globalState: JsonRecord): string[] {
  const roots: string[] = [];
  for (const key of ["project-order", "electron-saved-workspace-roots", "active-workspace-roots"]) {
    const value = globalState?.[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) roots.push(entry);
    }
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const normalized = normalizePathForCompare(root);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function findSavedProjectRoot(value: unknown, roots: string[]): string {
  const target = normalizePathForCompare(value);
  if (!target) return "";
  return roots.find((root) => normalizePathForCompare(root) === target) ?? "";
}

async function getProjects(home: string): Promise<Project[]> {
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
    `).all() as JsonRecord[];
    const byPath = new Map<string | null, Project>();
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

async function getProjectlessThreadIds(home: string): Promise<string[]> {
  const globalState = await readJsonIfPresent(globalStatePath(home), {});
  return Array.isArray(globalState["projectless-thread-ids"])
    ? globalState["projectless-thread-ids"].filter((id) => typeof id === "string" && id)
    : [];
}

async function getProjectlessThreads(home: string, flags: CliFlags = {}): Promise<Thread[]> {
  const ids = await getProjectlessThreadIds(home);
  return readThreads(home, { ...flags, all: true, ids });
}

async function readRolloutMeta(filePath: string): Promise<JsonRecord> {
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

async function readRolloutFirstRecord(filePath: string): Promise<{ raw: string; record: JsonRecord | null; rest: string }> {
  const raw = await fs.readFile(filePath, "utf8");
  const newlineIndex = raw.indexOf("\n");
  const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : raw.slice(newlineIndex);
  if (!firstLine.trim()) {
    return { raw, record: null, rest };
  }
  return { raw, record: JSON.parse(firstLine), rest };
}

async function prepareRolloutProviderUpdate(filePath: string, target: string | null): Promise<JsonRecord> {
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

async function scanRollouts(home: string): Promise<JsonRecord[]> {
  const roots = [
    path.join(home, "sessions"),
    path.join(home, "archived_sessions")
  ];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
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
  const metas: JsonRecord[] = [];
  for (const file of files) {
    try {
      const meta = await readRolloutMeta(file);
      metas.push({ path: file, id: meta.id, cwd: meta.cwd, model_provider: meta.model_provider });
    } catch (error) {
      metas.push({ path: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return metas;
}

async function collectProviderTagMismatches(
  home: string,
  target: string,
  { strictRolloutPaths = false }: { strictRolloutPaths?: boolean } = {}
): Promise<{ mismatches: JsonRecord[]; groups: JsonRecord[] }> {
  const threads = readThreads(home, { all: true });
  const mismatches: JsonRecord[] = [];
  const groups = new Map<string | null, number>();
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
          rolloutError = error instanceof Error ? error.message : String(error);
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

async function collectProviderConsistencyMismatches(
  home: string,
  { strictRolloutPaths = false }: { strictRolloutPaths?: boolean } = {}
): Promise<{ mismatches: JsonRecord[]; groups: JsonRecord[] }> {
  const threads = readThreads(home, { all: true });
  const mismatches: JsonRecord[] = [];
  const groups = new Map<string, number>();
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

async function getStatus(home: string): Promise<Status> {
  const db = openDb(home, { readOnly: true });
  let integrity = "unknown";
  let providerRows: JsonRecord[] = [];
  let totals: JsonRecord = {};
  try {
    integrity = String((db.prepare("PRAGMA integrity_check").get() as JsonRecord).integrity_check);
    providerRows = db.prepare(`
      SELECT model_provider, archived, COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, model_provider
    `).all() as JsonRecord[];
    totals = db.prepare(`
      SELECT
        COUNT(*) AS threads,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN has_user_event = 1 THEN 1 ELSE 0 END) AS interactive
      FROM threads
    `).get() as JsonRecord;
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
  const rolloutProviderCounts: Record<string, number> = {};
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

async function createBackup(home: string, reason: string, targetThreads: Thread[] = []): Promise<string> {
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
    chatSummaries: targetThreads.map(compactThreadSummary),
    copiedRollouts
  };
  await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  return dir;
}

async function restoreDbFilesFromBackup(home: string, backupDir: string): Promise<boolean> {
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

async function restoreProviderMetadataFromBackup(home: string, backupDir: string, threadIds: unknown): Promise<{ restoredThreads: number; restoredRows: number }> {
  const ids = uniqueStrings(threadIds);
  if (!ids.length) return { restoredThreads: 0, restoredRows: 0 };
  const backupDb = path.join(backupDir, "db", DB_NAME);
  if (!(await pathExists(backupDb))) return { restoredThreads: 0, restoredRows: 0 };
  const db = openDb(home);
  const backupAlias = "backup_state";
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`ATTACH DATABASE ${sqlString(backupDb)} AS ${quoteIdent(backupAlias)}`);
    if (!attachedTableColumns(db, backupAlias, "threads").size) {
      return { restoredThreads: 0, restoredRows: 0 };
    }
    db.exec("BEGIN IMMEDIATE");
    const params = [...ids];
    const idPlaceholders = placeholders(params);
    let restoredRows = 0;

    const currentThreadColumns = getColumns(db, "threads");
    const attachedThreadColumns = attachedTableColumns(db, backupAlias, "threads");
    const columns = [...currentThreadColumns].filter((column) => attachedThreadColumns.has(column));
    if (columns.length) {
      const quotedColumns = columns.map(quoteIdent).join(", ");
      const selectColumns = columns.map((column) => `${quoteIdent(backupAlias)}.${quoteIdent("threads")}.${quoteIdent(column)}`).join(", ");
      db.prepare(`DELETE FROM threads WHERE id IN (${idPlaceholders})`).run(...params);
      const insert = db.prepare(`
        INSERT INTO threads (${quotedColumns})
        SELECT ${selectColumns}
        FROM ${quoteIdent(backupAlias)}.${quoteIdent("threads")}
        WHERE id IN (${idPlaceholders})
      `).run(...params);
      restoredRows += Number(insert.changes ?? 0);
    }

    const childTables = [
      "thread_dynamic_tools",
      "thread_spawn_edges",
      "agent_job_items"
    ];
    for (const table of childTables) {
      if (!tableExists(db, table)) continue;
      const attachedColumns = attachedTableColumns(db, backupAlias, table);
      if (!attachedColumns.size) continue;
      const columnsForTable = [...getColumns(db, table)].filter((column) => attachedColumns.has(column));
      if (!columnsForTable.length) continue;
      const quotedColumns = columnsForTable.map(quoteIdent).join(", ");
      const selectColumns = columnsForTable.map((column) => `${quoteIdent(backupAlias)}.${quoteIdent(table)}.${quoteIdent(column)}`).join(", ");
      let column;
      let where;
      if (table === "thread_spawn_edges") {
        where = `(parent_thread_id IN (${idPlaceholders}) OR child_thread_id IN (${idPlaceholders}))`;
        db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE parent_thread_id IN (${idPlaceholders}) OR child_thread_id IN (${idPlaceholders})`).run(...params, ...params);
        const info = db.prepare(`
          INSERT OR IGNORE INTO ${quoteIdent(table)} (${quotedColumns})
          SELECT ${selectColumns}
          FROM ${quoteIdent(backupAlias)}.${quoteIdent(table)}
          WHERE ${where}
        `).run(...params, ...params);
        restoredRows += Number(info.changes ?? 0);
        continue;
      }
      column = table === "agent_job_items" ? "assigned_thread_id" : "thread_id";
      if (!columnsForTable.includes(column)) continue;
      db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IN (${idPlaceholders})`).run(...params);
      const info = db.prepare(`
        INSERT OR IGNORE INTO ${quoteIdent(table)} (${quotedColumns})
        SELECT ${selectColumns}
        FROM ${quoteIdent(backupAlias)}.${quoteIdent(table)}
        WHERE ${quoteIdent(column)} IN (${idPlaceholders})
      `).run(...params);
      restoredRows += Number(info.changes ?? 0);
    }

    db.exec("COMMIT");
    return { restoredThreads: ids.length, restoredRows };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw error;
  } finally {
    try {
      db.exec(`DETACH DATABASE ${quoteIdent(backupAlias)}`);
    } catch {
      // Ignore detach cleanup failures after the main operation is done.
    }
    db.close();
  }
}

async function restoreThreadProviderTagsFromBackup(home: string, backupDir: string, threadIds: unknown): Promise<{ restoredThreads: number; restoredRows: number }> {
  const ids = uniqueStrings(threadIds);
  if (!ids.length) return { restoredThreads: 0, restoredRows: 0 };
  const backupDb = path.join(backupDir, "db", DB_NAME);
  if (!(await pathExists(backupDb))) return { restoredThreads: 0, restoredRows: 0 };
  const db = openDb(home);
  const backupAlias = "backup_state";
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`ATTACH DATABASE ${sqlString(backupDb)} AS ${quoteIdent(backupAlias)}`);
    const currentColumns = getColumns(db, "threads");
    const backupColumns = attachedTableColumns(db, backupAlias, "threads");
    if (!currentColumns.has("model_provider") || !backupColumns.has("model_provider")) {
      return { restoredThreads: 0, restoredRows: 0 };
    }
    const idPlaceholders = placeholders(ids);
    db.exec("BEGIN IMMEDIATE");
    const info = db.prepare(`
      UPDATE threads
      SET model_provider = (
        SELECT ${quoteIdent("model_provider")}
        FROM ${quoteIdent(backupAlias)}.${quoteIdent("threads")} AS backup_threads
        WHERE backup_threads.id = threads.id
      )
      WHERE id IN (${idPlaceholders})
        AND EXISTS (
          SELECT 1
          FROM ${quoteIdent(backupAlias)}.${quoteIdent("threads")} AS backup_threads
          WHERE backup_threads.id = threads.id
        )
    `).run(...ids);
    db.exec("COMMIT");
    return { restoredThreads: ids.length, restoredRows: Number(info.changes ?? 0) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw error;
  } finally {
    try {
      db.exec(`DETACH DATABASE ${quoteIdent(backupAlias)}`);
    } catch {
      // Ignore detach cleanup failures after the main operation is done.
    }
    db.close();
  }
}

async function alignThreadsToActiveProvider(home: string, threadIds: unknown): Promise<{ target: string | null; dbUpdated: number; rolloutUpdated: number }> {
  const target = summarizeConfig(await readTextIfPresent(configPath(home), "") ?? "").modelProvider;
  const ids = uniqueStrings(threadIds);
  if (!target || !ids.length) {
    return { target: target ?? null, dbUpdated: 0, rolloutUpdated: 0 };
  }
  const threads = readThreads(home, { all: true, ids });
  if (!threads.length) return { target, dbUpdated: 0, rolloutUpdated: 0 };
  const db = openDb(home);
  let dbUpdated = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const info = db.prepare(`UPDATE threads SET model_provider = ? WHERE id IN (${placeholders(ids)}) AND model_provider <> ?`).run(target, ...ids, target);
    db.exec("COMMIT");
    dbUpdated = Number(info.changes ?? 0);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw error;
  } finally {
    db.close();
  }

  let rolloutUpdated = 0;
  for (const thread of threads) {
    if (!thread.rollout_path || !(await pathExists(thread.rollout_path)) || !isInsideDir(home, thread.rollout_path)) continue;
    const prepared = await prepareRolloutProviderUpdate(thread.rollout_path, target);
    if (!prepared.changed) continue;
    await writeFilePreservingTimes(thread.rollout_path, prepared.content);
    rolloutUpdated += 1;
  }
  return { target, dbUpdated, rolloutUpdated };
}

async function restoreMutableFilesFromBackup(home: string, backupDir: string): Promise<void> {
  for (const name of [GLOBAL_STATE, `${GLOBAL_STATE}.bak`, CONFIG_NAME, AUTH_NAME]) {
    const file = path.join(backupDir, name);
    if (await pathExists(file)) {
      await fs.copyFile(file, path.join(home, name));
    }
  }
}

async function restoreConfigFilesFromBackup(home: string, backupDir: string): Promise<number> {
  let restored = 0;
  for (const name of [CONFIG_NAME, AUTH_NAME]) {
    const file = path.join(backupDir, name);
    if (await pathExists(file)) {
      await fs.copyFile(file, path.join(home, name));
      restored += 1;
    }
  }
  return restored;
}

async function restoreCopiedRolloutsFromBackup(backupDir: string): Promise<number> {
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

async function restoreProviderTagsInCopiedRolloutsFromBackup(backupDir: string): Promise<number> {
  const metadata = await readJsonIfPresent(path.join(backupDir, "metadata.json"), null);
  let restored = 0;
  for (const rollout of metadata?.copiedRollouts ?? []) {
    if (!rollout?.backupPath || !rollout?.originalPath || !(await pathExists(rollout.backupPath))) continue;
    if (!(await pathExists(rollout.originalPath))) continue;
    let backupMeta;
    try {
      backupMeta = await readRolloutMeta(rollout.backupPath);
    } catch {
      continue;
    }
    if (!backupMeta.model_provider) continue;
    const prepared = await prepareRolloutProviderUpdate(rollout.originalPath, backupMeta.model_provider);
    if (!prepared.changed) continue;
    await writeFilePreservingTimes(rollout.originalPath, prepared.content);
    restored += 1;
  }
  return restored;
}

async function restoreTrashFilesFromBackup(home: string, backupDir: string): Promise<number> {
  const trashRoot = path.join(backupDir, "trash");
  async function restoreTrash(dir: string): Promise<number> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
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
  return restoreTrash(trashRoot);
}

async function restoreMutationBackup(home: string, backupDir: string): Promise<{ restoredRollouts: number }> {
  await restoreDbFilesFromBackup(home, backupDir);
  await restoreMutableFilesFromBackup(home, backupDir);
  const restoredRollouts = await restoreCopiedRolloutsFromBackup(backupDir);
  return { restoredRollouts };
}

function classifyBackup(reason: unknown, metadata: JsonRecord = {}): BackupClassification {
  const text = String(reason ?? "");
  if (text.startsWith("trash-thread:")) {
    return {
      category: "chats",
      kind: "chat",
      title: "Deleted chat",
      subject: text.slice("trash-thread:".length),
      scopes: ["chats"]
    };
  }
  if (text.startsWith("delete-project:")) {
    return {
      category: "chats",
      kind: "project",
      title: "Deleted project",
      subject: text.slice("delete-project:".length),
      scopes: ["chats"]
    };
  }
  if (text.startsWith("config-sync:repair")) {
    return {
      category: "sync",
      kind: "repair",
      title: "Provider metadata repair",
      subject: "SQLite / rollout mismatch repair",
      scopes: ["metadata"]
    };
  }
  if (text.startsWith("config-sync:")) {
    return {
      category: "sync",
      kind: "retag",
      title: "Provider retag",
      subject: text.slice("config-sync:".length),
      scopes: ["metadata"]
    };
  }
  if (text.startsWith("profile-switch:")) {
    return {
      category: "providers",
      kind: "profile-switch",
      title: "Provider switch",
      subject: text.slice("profile-switch:".length),
      scopes: ["config"]
    };
  }
  if (text.startsWith("config-file-write:")) {
    return {
      category: "providers",
      kind: "config-file",
      title: "Config file edit",
      subject: text.slice("config-file-write:".length),
      scopes: ["config"]
    };
  }
  if (text.startsWith("config-fix-reserved:")) {
    return {
      category: "providers",
      kind: "config-fix",
      title: "Provider config fix",
      subject: text.slice("config-fix-reserved:".length),
      scopes: ["config"]
    };
  }
  if (text.startsWith("pre-restore:")) {
    return {
      category: "providers",
      kind: "pre-restore",
      title: "Pre-restore safety backup",
      subject: text.slice("pre-restore:".length),
      scopes: ["config"]
    };
  }
  if (text.startsWith("config-") || text === "config-fields") {
    return {
      category: "providers",
      kind: "config",
      title: "Config snapshot",
      subject: text || "config",
      scopes: ["config"]
    };
  }
  if ((metadata.threadIds ?? []).length || (metadata.copiedRollouts ?? []).length) {
    return {
      category: "chats",
      kind: "chat-state",
      title: "Chat state backup",
      subject: `${metadata.threadIds?.length ?? 0} chat(s)`,
      scopes: ["chats"]
    };
  }
  return {
    category: "providers",
    kind: "snapshot",
    title: "State snapshot",
    subject: text || "backup",
    scopes: ["config"]
  };
}

async function backupFileFlags(backupPath: string): Promise<BackupFiles> {
  const files: BackupFiles = {
    db: await pathExists(path.join(backupPath, "db", DB_NAME)),
    config: await pathExists(path.join(backupPath, CONFIG_NAME)),
    auth: await pathExists(path.join(backupPath, AUTH_NAME)),
    globalState: await pathExists(path.join(backupPath, GLOBAL_STATE)),
    trashManifest: await pathExists(path.join(backupPath, "trash-manifest.json")),
    mutable: false
  };
  files.mutable = files.config || files.auth || files.globalState;
  return files;
}

function readBackupThreadSummaries(backupPath: string, threadIds: unknown): Thread[] {
  const ids = uniqueStrings(threadIds);
  if (!ids.length) return [];
  const backupDb = path.join(backupPath, "db", DB_NAME);
  const db = new DatabaseSync(backupDb, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT
        id, rollout_path, created_at, updated_at, source, thread_source,
        model_provider, cwd, title, archived, archived_at, has_user_event,
        first_user_message, preview
      FROM threads
      WHERE id IN (${placeholders(ids)})
      ORDER BY updated_at DESC, id DESC
    `).all(...ids) as Thread[];
    return rows.map(compactThreadSummary);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readBackupGlobalState(backupPath: string): Promise<JsonRecord> {
  return readJsonIfPresent(path.join(backupPath, GLOBAL_STATE), {});
}

function enrichBackupChatContext(chatSummaries: Thread[], backupState: JsonRecord): Thread[] {
  const projectlessIds = new Set(
    Array.isArray(backupState?.["projectless-thread-ids"])
      ? backupState["projectless-thread-ids"].filter((id) => typeof id === "string" && id)
      : []
  );
  const hints = backupState?.["thread-workspace-root-hints"] && typeof backupState["thread-workspace-root-hints"] === "object"
    ? backupState["thread-workspace-root-hints"]
    : {};
  const roots = savedProjectRoots(backupState);
  return chatSummaries.map((thread) => {
    const workspaceRootHint = typeof hints[thread.id] === "string" ? hints[thread.id] : "";
    const projectless = projectlessIds.has(thread.id);
    const savedProjectRoot = projectless
      ? ""
      : findSavedProjectRoot(thread.cwd, roots) || findSavedProjectRoot(workspaceRootHint, roots);
    return {
      ...thread,
      projectless,
      workspaceRootHint,
      savedProjectRoot
    };
  });
}

async function backupSummary(backupPath: string, name: string, metadata: JsonRecord | null, stat: { mtime: Date }, home: string): Promise<BackupSummary> {
  const reason = metadata?.reason ?? "";
  const classification = classifyBackup(reason, metadata ?? {});
  const files = await backupFileFlags(backupPath);
  const backupState = files.globalState ? await readBackupGlobalState(backupPath) : {};
  const savedRoots = savedProjectRoots(backupState);
  const projectRoot = classification.category === "chats" && classification.kind === "project"
    ? findSavedProjectRoot(classification.subject, savedRoots)
    : "";
  const chatSummaries = Array.isArray(metadata?.chatSummaries)
    ? metadata.chatSummaries.map(compactThreadSummary)
    : files.db
      ? readBackupThreadSummaries(backupPath, metadata?.threadIds ?? [])
      : [];
  const enrichedChatSummaries = enrichBackupChatContext(chatSummaries, backupState);
  return {
    name,
    path: backupPath,
    createdAt: metadata?.createdAt ?? stat.mtime.toISOString(),
    reason,
    category: classification.category,
    kind: classification.kind,
    title: classification.title,
    subject: classification.subject,
    projectRoot,
    scopes: classification.scopes,
    files,
    threadIds: metadata?.threadIds ?? [],
    chatSummaries: enrichedChatSummaries,
    copiedRollouts: metadata?.copiedRollouts ?? [],
    codexHome: metadata?.codexHome ?? home
  };
}

async function listBackups(home: string): Promise<BackupSummary[]> {
  let entries = [];
  try {
    entries = await fs.readdir(backupRoot(home), { withFileTypes: true });
  } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupPath = path.join(backupRoot(home), entry.name);
    let metadata: JsonRecord | null = null;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(backupPath, "metadata.json"), "utf8"));
    } catch {
      metadata = null;
    }
    const stat = await fs.stat(backupPath);
    backups.push(await backupSummary(backupPath, entry.name, metadata, stat, home));
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function resolveProjectRef(home: string, ref: unknown): Promise<string | undefined> {
  if (!String(ref).startsWith("#")) return typeof ref === "string" ? ref : undefined;
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

async function resolveBackupRef(home: string, ref: unknown): Promise<string | undefined> {
  if (!String(ref).startsWith("#")) return typeof ref === "string" ? ref : undefined;
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

function safeBackupDirForDelete(home: string, backupDir: string): string {
  const root = path.resolve(backupRoot(home));
  const source = path.resolve(backupDir);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`Refusing to delete backup outside ${backupRoot(home)}: ${source}`);
  }
  return source;
}

function removeThreadRefsFromGlobalState(state: JsonRecord, ids: string[]): void {
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

function mergeThreadRefsIntoGlobalState(targetState: JsonRecord, backupState: JsonRecord, ids: unknown): { arrays: number; objects: number } {
  const idSet = new Set(uniqueStrings(ids));
  if (!idSet.size) return { arrays: 0, objects: 0 };
  let arrays = 0;
  let objects = 0;
  const arrayKeys = ["projectless-thread-ids", "pinned-thread-ids"];
  for (const key of arrayKeys) {
    const backupValues = Array.isArray(backupState?.[key]) ? backupState[key].filter((id) => idSet.has(id)) : [];
    if (!backupValues.length) continue;
    const current = Array.isArray(targetState[key]) ? targetState[key] : [];
    const seen = new Set(current);
    for (const id of backupValues) {
      if (seen.has(id)) continue;
      current.push(id);
      seen.add(id);
      arrays += 1;
    }
    targetState[key] = current;
  }

  const objectKeys = [
    "thread-workspace-root-hints",
    "thread-projectless-output-directories"
  ];
  const backupPersisted = backupState?.["electron-persisted-atom-state"];
  if (backupPersisted && typeof backupPersisted === "object") {
    if (!targetState["electron-persisted-atom-state"] || typeof targetState["electron-persisted-atom-state"] !== "object") {
      targetState["electron-persisted-atom-state"] = {};
    }
    objectKeys.push("heartbeat-thread-permissions-by-id");
    if (backupPersisted["unread-thread-ids-by-host-v1"] && typeof backupPersisted["unread-thread-ids-by-host-v1"] === "object") {
      const targetUnread = targetState["electron-persisted-atom-state"]["unread-thread-ids-by-host-v1"] ?? {};
      for (const [host, values] of Object.entries(backupPersisted["unread-thread-ids-by-host-v1"])) {
        if (!Array.isArray(values)) continue;
        const matching = values.filter((id) => idSet.has(id));
        if (!matching.length) continue;
        const current = Array.isArray(targetUnread[host]) ? targetUnread[host] : [];
        const seen = new Set(current);
        for (const id of matching) {
          if (seen.has(id)) continue;
          current.push(id);
          seen.add(id);
          arrays += 1;
        }
        targetUnread[host] = current;
      }
      targetState["electron-persisted-atom-state"]["unread-thread-ids-by-host-v1"] = targetUnread;
    }
  }
  for (const key of objectKeys) {
    const backupHolder = key === "heartbeat-thread-permissions-by-id" ? backupPersisted : backupState;
    if (!backupHolder?.[key] || typeof backupHolder[key] !== "object" || Array.isArray(backupHolder[key])) continue;
    const targetHolder = key === "heartbeat-thread-permissions-by-id" ? targetState["electron-persisted-atom-state"] : targetState;
    if (!targetHolder[key] || typeof targetHolder[key] !== "object" || Array.isArray(targetHolder[key])) {
      targetHolder[key] = {};
    }
    for (const id of idSet) {
      if (!(id in backupHolder[key])) continue;
      targetHolder[key][id] = backupHolder[key][id];
      objects += 1;
    }
  }
  return { arrays, objects };
}

function mergeProjectRefsIntoGlobalState(targetState: JsonRecord, backupState: JsonRecord, projectPath: unknown): { projects: number } {
  const target = normalizePathForCompare(projectPath);
  if (!target) return { projects: 0 };
  let projects = 0;
  for (const key of ["electron-saved-workspace-roots", "project-order", "active-workspace-roots"]) {
    const backupValues = Array.isArray(backupState?.[key])
      ? backupState[key].filter((entry) => normalizePathForCompare(entry) === target)
      : [];
    if (!backupValues.length) continue;
    const current = Array.isArray(targetState[key]) ? targetState[key] : [];
    const seen = new Set(current.map(normalizePathForCompare).filter(Boolean));
    for (const entry of backupValues) {
      const normalized = normalizePathForCompare(entry);
      if (!normalized || seen.has(normalized)) continue;
      current.push(entry);
      seen.add(normalized);
      projects += 1;
    }
    targetState[key] = current;
  }
  return { projects };
}

async function restoreThreadRefsFromBackup(home: string, backupDir: string, threadIds: unknown, projectPath: string | null = null): Promise<JsonRecord> {
  const backupState = await readJsonIfPresent(path.join(backupDir, GLOBAL_STATE), null);
  if (!backupState) return { arrays: 0, objects: 0, projects: 0, restored: false };
  const state = await readJsonIfPresent(globalStatePath(home), {});
  const merged = mergeThreadRefsIntoGlobalState(state, backupState, threadIds);
  const projectRefs = mergeProjectRefsIntoGlobalState(state, backupState, projectPath);
  await writeGlobalState(home, state);
  return { ...merged, ...projectRefs, restored: true };
}

function removeProjectRootFromGlobalState(state: JsonRecord, projectPath: string): number {
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

function countProjectRootRefs(state: JsonRecord, projectPath: string): number {
  const target = normalizePathForCompare(projectPath);
  let count = 0;
  for (const key of ["electron-saved-workspace-roots", "project-order", "active-workspace-roots"]) {
    if (!Array.isArray(state[key])) continue;
    count += state[key].filter((entry) => normalizePathForCompare(entry) === target).length;
  }
  return count;
}

function assertThreadRolloutsInsideHome(home: string, threads: Thread[]): void {
  for (const thread of threads) {
    if (thread.rollout_path) {
      relativeInside(home, thread.rollout_path);
    }
  }
}

async function writeGlobalState(home: string, state: JsonRecord): Promise<void> {
  await fs.writeFile(globalStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

async function trashThreads(
  home: string,
  threads: Thread[],
  { execute, reason, backupDir: existingBackupDir = null }: { execute: boolean; reason: string; backupDir?: string | null }
): Promise<JsonRecord> {
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

async function deleteProject(home: string, projectPath: string, { execute }: { execute: boolean }): Promise<JsonRecord> {
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
  let trashResult: JsonRecord = { trashed: 0, moved: [] };
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

async function restoreBackup(home: string, backupDir: string, execute: boolean, scope?: BackupScope): Promise<JsonRecord> {
  const source = path.resolve(backupDir);
  const metadata = await readJsonIfPresent(path.join(source, "metadata.json"), null);
  if (!metadata) {
    throw new Error(`Not a codex-chat-manager backup: ${source}`);
  }
  const stat = await fs.stat(source);
  const backup = await backupSummary(source, path.basename(source), metadata, stat, home);
  const defaultScope = backup.scopes[0] ?? "config";
  const safeScope = scope && backup.scopes.includes(scope) ? scope : defaultScope;
  if (!execute) {
    return { dryRun: true, backupDir: source, metadata, backup, scope: safeScope };
  }

  const backupBeforeRestore = await createBackup(home, `pre-restore:${source}`, []);
  let restoredDb = false;
  let restoredMutable = false;
  let restoredConfigFiles = 0;
  let restoredMetadata = { restoredThreads: 0, restoredRows: 0 };
  let alignedProvider: { target: string | null; dbUpdated: number; rolloutUpdated: number } = { target: null, dbUpdated: 0, rolloutUpdated: 0 };
  let restoredThreadRefs: JsonRecord = { arrays: 0, objects: 0, restored: false };
  let restoredFiles = 0;
  try {
    if (safeScope === "config") {
      restoredConfigFiles = await restoreConfigFilesFromBackup(home, source);
      restoredMutable = true;
    } else if (safeScope === "metadata") {
      restoredMetadata = await restoreThreadProviderTagsFromBackup(home, source, metadata.threadIds ?? []);
      restoredFiles = await restoreProviderTagsInCopiedRolloutsFromBackup(source);
    } else if (safeScope === "chats") {
      restoredMetadata = await restoreProviderMetadataFromBackup(home, source, metadata.threadIds ?? []);
      restoredFiles = await restoreTrashFilesFromBackup(home, source);
      restoredThreadRefs = await restoreThreadRefsFromBackup(home, source, metadata.threadIds ?? [], backup.projectRoot || null);
      alignedProvider = await alignThreadsToActiveProvider(home, metadata.threadIds ?? []);
    }
  } catch (error) {
    await restoreMutationBackup(home, backupBeforeRestore);
    throw error;
  }
  return {
    dryRun: false,
    backupDir: source,
    backup,
    scope: safeScope,
    preRestoreBackup: backupBeforeRestore,
    restoredDb,
    restoredMutable,
    restoredConfigFiles,
    restoredMetadata,
    restoredThreadRefs,
    alignedProvider,
    restoredFiles
  };
}

async function deleteBackup(home: string, backupDir: string, { execute }: { execute: boolean }): Promise<JsonRecord> {
  const source = safeBackupDirForDelete(home, backupDir);
  let stat;
  try {
    stat = await fs.stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Backup not found: ${source}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Backup is not a directory: ${source}`);
  }
  const metadata = await readJsonIfPresent(path.join(source, "metadata.json"), null);
  const backup = await backupSummary(source, path.basename(source), metadata, stat, home);
  if (!execute) {
    return { dryRun: true, backupDir: source, backup, deleted: false };
  }
  await fs.rm(source, { recursive: true, force: false });
  return { dryRun: false, backupDir: source, backup, deleted: true };
}

export {
  assertThreadRolloutsInsideHome,
  codexHome,
  collectProviderTagMismatches,
  collectProviderConsistencyMismatches,
  createBackup,
  deleteBackup,
  deleteProject,
  getProjectlessThreads,
  getProjects,
  getStatus,
  isTruthy,
  listBackups,
  openDb,
  parseLimit,
  parsePort,
  placeholders,
  prepareRolloutProviderUpdate,
  readJsonIfPresent,
  readThreadByRef,
  readThreads,
  resolveBackupRef,
  resolveProjectRef,
  restoreBackup,
  restoreMutationBackup,
  timestamp,
  trashThreads,
  writeFilePreservingTimes
};
