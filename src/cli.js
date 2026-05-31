#!/usr/bin/env node

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
const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RELAY_BASE_URL = "https://api.axis.fan";
const DEFAULT_RELAY_PROVIDER_ID = "openai-custom";
// Codex reserves these provider ids; a custom [model_providers.<id>] block cannot override them.
const BUILTIN_PROVIDER_IDS = new Set(["openai"]);

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

function shouldColor() {
  return process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR);
}

function color(code, value) {
  return shouldColor() ? `${code}${value}${COLOR.reset}` : String(value);
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function usage() {
  console.log(`${color(COLOR.bold, "codex-chat-manager")}

${color(COLOR.cyan, "Quick start")}
  codex-chat-manager status
  codex-chat-manager chats --limit 20
  codex-chat-manager projects
  codex-chat-manager backups
  codex-chat-manager web

${color(COLOR.cyan, "Delete, safely")}
  codex-chat-manager delete-chat <chat-id-or-prefix>
  codex-chat-manager delete-chat <chat-id-or-prefix> --yes
  codex-chat-manager delete-project '<path-or-#number>'
  codex-chat-manager delete-project '<path-or-#number>' --yes

${color(COLOR.cyan, "Commands")}
  status
  projects | ps
  list | chats | ls [--project PATH] [--provider ID] [--archived] [--all] [--limit N]
  delete-chat | trash-thread | rm-chat <chat-id-or-prefix>
  delete-project | rm-project '<path-or-#number>'
  trash-provider | delete-provider <provider-id>
  backups
  restore <backup-dir-or-#number>
  web [--port 8765]

${color(COLOR.cyan, "Config / provider switching")}
  config | cfg
  config-apply --preset official|thirdparty
  config-apply --base-url URL --requires-auth false --bearer KEEP|REMOVE|TOKEN
  config-apply --profile <profile-id>
  config-save-profile <label> [--note TEXT]
  config-delete-profile <profile-id>
  config-sync | sync [--to <provider-id>]   Retag all chats to the active provider so history stays visible
  config-fix | fix-reserved [--to <id>]     Rename a reserved [model_providers.openai] block to a custom id

${color(COLOR.cyan, "Options")}
  --codex-home PATH   Use another Codex home, default ~/.codex
  --json              Print machine-readable JSON
  --yes               Execute a mutation; without it, mutations are previews
  --no-color          Disable ANSI color
`);
}

function normalizeCommand(command) {
  const aliases = {
    chat: "list",
    chats: "list",
    ls: "list",
    ps: "projects",
    backup: "backups",
    delete: "trash-thread",
    "delete-chat": "trash-thread",
    "rm-chat": "trash-thread",
    "rm-thread": "trash-thread",
    "delete-provider": "trash-provider",
    "rm-provider": "trash-provider",
    "rm-project": "delete-project",
    serve: "web",
    ui: "web",
    config: "config-show",
    cfg: "config-show",
    "save-profile": "config-save-profile",
    "delete-profile": "config-delete-profile",
    sync: "config-sync",
    "sync-provider": "config-sync",
    "fix-reserved": "config-fix",
    "fix-provider": "config-fix"
  };
  return aliases[command] ?? command;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function compactPath(value) {
  if (!value) return "";
  const home = os.homedir();
  return String(value).replace(home, "~");
}

function shortId(value, length = 18) {
  if (!value) return "";
  return String(value).slice(0, length);
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatDateObject(date) {
  if (Number.isNaN(date.getTime())) return "-";
  return [
    date.getFullYear(),
    "-",
    twoDigits(date.getMonth() + 1),
    "-",
    twoDigits(date.getDate()),
    " ",
    twoDigits(date.getHours()),
    ":",
    twoDigits(date.getMinutes())
  ].join("");
}

function formatDate(seconds) {
  if (!seconds) return "-";
  return formatDateObject(new Date(seconds * 1000));
}

function formatIsoDate(value) {
  if (!value) return "-";
  return formatDateObject(new Date(value));
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (stripAnsi(text).length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, Math.max(0, width - 1))}.`;
}

function pad(value, width, align = "left") {
  const text = String(value ?? "");
  const size = stripAnsi(text).length;
  if (size >= width) return text;
  const spaces = " ".repeat(width - size);
  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

function printTitle(title) {
  console.log(color(COLOR.bold, title));
  console.log(color(COLOR.gray, "-".repeat(Math.max(16, stripAnsi(title).length))));
}

function printKeyValues(rows) {
  const width = Math.max(...rows.map(([key]) => stripAnsi(key).length), 0);
  for (const [key, value] of rows) {
    console.log(`${color(COLOR.gray, pad(key, width))}  ${value}`);
  }
}

function printTable(columns, rows, { empty = "No rows." } = {}) {
  if (!rows.length) {
    console.log(color(COLOR.gray, empty));
    return;
  }
  const widths = columns.map((column) => {
    const values = rows.map((row) => truncate(row[column.key], column.width ?? 30));
    const max = Math.max(stripAnsi(column.label).length, ...values.map((value) => stripAnsi(value).length));
    return Math.min(column.width ?? max, Math.max(max, column.min ?? 0));
  });
  console.log(columns.map((column, index) => color(COLOR.bold, pad(truncate(column.label, widths[index]), widths[index], column.align))).join("  "));
  console.log(columns.map((_, index) => color(COLOR.gray, "-".repeat(widths[index]))).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => pad(truncate(row[column.key], widths[index]), widths[index], column.align)).join("  "));
  }
}

function printNext(command) {
  console.log("");
  console.log(`${color(COLOR.gray, "Next")}  ${command}`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.split("=", 2);
    const name = rawName.slice(2);
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

function codexHome(flags) {
  return path.resolve(flags["codex-home"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function dbPath(home) {
  return path.join(home, DB_NAME);
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
    const { sql, params } = buildThreadQuery(flags);
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
    return [...byPath.values()].sort((left, right) => (right.updated_at ?? 0) - (left.updated_at ?? 0));
  } finally {
    db.close();
  }
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

  return {
    codexHome: home,
    integrity,
    totals,
    sqliteProviders: providerRows,
    rolloutFiles: rollouts.length,
    rolloutProviders: rolloutProviderCounts,
    missingRolloutCount: missingRollout.length,
    missingDbCount: missingDb.length,
    rolloutPathOutsideHomeCount: rolloutPathOutsideHome.length,
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
  for (const file of [globalStatePath(home), `${globalStatePath(home)}.bak`, path.join(home, "config.toml")]) {
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
  const dbBackup = path.join(source, "db", DB_NAME);
  if (await pathExists(dbBackup)) {
    await fs.copyFile(dbBackup, dbPath(home));
  }
  for (const name of [GLOBAL_STATE, `${GLOBAL_STATE}.bak`, "config.toml"]) {
    const file = path.join(source, name);
    if (await pathExists(file)) {
      await fs.copyFile(file, path.join(home, name));
    }
  }
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

function summarizeConfig(text) {
  const lines = text.split("\n");
  const [topStart, topEnd] = topLevelRange(lines);
  const model = readScalarInRange(lines, topStart, topEnd, "model");
  const modelProvider = readScalarInRange(lines, topStart, topEnd, "model_provider");
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
    modelProvider: modelProvider ?? null,
    provider,
    bearer: bearer
      ? { present: true, masked: maskToken(bearer), value: String(bearer) }
      : { present: false, masked: "", value: "" }
  };
}

function providerKind(provider, modelProvider) {
  // The distinction is the auth mode, not the URL:
  //   official    = requires_openai_auth = true  (Codex auth.json / ChatGPT login)
  //   third-party = requires_openai_auth = false (config.toml base_url + bearer, no auth)
  if (provider) {
    if (provider.requiresOpenaiAuth === true) return "official";
    if (provider.requiresOpenaiAuth === false) return "third-party";
  }
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
      throw new Error(`config.toml defines [model_providers.${id}], but "${id}" is a reserved built-in provider that cannot be overridden. Rename it to a custom id (e.g. ${DEFAULT_RELAY_PROVIDER_ID}).`);
    }
  }
}

function buildPresets(summary) {
  const provider = summary.provider ?? {};
  const kind = providerKind(provider, summary.modelProvider);
  const relayUrl = kind === "third-party" && provider.baseUrl ? provider.baseUrl : DEFAULT_RELAY_BASE_URL;
  // Re-use the current custom id when it is already a valid (non-reserved) third-party id.
  const relayId = summary.modelProvider && !isReservedProviderId(summary.modelProvider)
    ? summary.modelProvider
    : DEFAULT_RELAY_PROVIDER_ID;
  return [
    {
      id: "official",
      label: "Official OpenAI",
      kind: "official",
      note: "Built-in OpenAI provider, authenticated via auth.json (ChatGPT login). No custom block.",
      // Built-in openai must NOT have a custom block; just point model_provider at it.
      fields: { modelProvider: "openai" }
    },
    {
      id: "thirdparty",
      label: "Third-party relay",
      kind: "third-party",
      note: `Custom provider "${relayId}" in config.toml with a bearer token, no auth.`,
      fields: { modelProvider: relayId, baseUrl: relayUrl, wireApi: "responses", requiresOpenaiAuth: false, bearer: "keep" }
    }
  ];
}

function applyConfigFields(text, fields) {
  const lines = text.split("\n");
  const changes = [];
  const summary = summarizeConfig(text);
  const providerKey = fields.modelProvider ?? summary.modelProvider;

  const editTop = (key, value) => {
    const [start, end] = topLevelRange(lines);
    const before = readScalarInRange(lines, start, end, key);
    const result = setScalarInRange(lines, start, end, key, value, end);
    if (result.changed) changes.push({ scope: "top", key, before: before ?? null, after: value });
  };
  const ensureProviderBlock = () => {
    if (providerRange(lines, providerKey)) return;
    if (isReservedProviderId(providerKey)) {
      throw new Error(`"${providerKey}" is a reserved built-in provider and cannot have a custom [model_providers] block. Use a custom id like ${DEFAULT_RELAY_PROVIDER_ID}.`);
    }
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[model_providers.${providerKey}]`, `name = "${providerKey}"`);
    changes.push({ scope: "provider", key: "[block]", before: null, after: providerKey });
  };
  const editProvider = (key, value) => {
    ensureProviderBlock();
    const [start, end] = providerRange(lines, providerKey);
    const before = readScalarInRange(lines, start, end, key);
    const result = setScalarInRange(lines, start, end, key, value, start + 1);
    if (result.changed) changes.push({ scope: "provider", key, before: before ?? null, after: value });
  };

  const hasProviderFields = ["baseUrl", "wireApi", "requiresOpenaiAuth", "envKey"]
    .some((key) => fields[key] !== undefined);

  if (fields.modelProvider !== undefined) editTop("model_provider", fields.modelProvider);
  if (fields.model !== undefined) editTop("model", fields.model);
  if (hasProviderFields) {
    if (fields.baseUrl !== undefined) editProvider("base_url", fields.baseUrl);
    if (fields.wireApi !== undefined) editProvider("wire_api", fields.wireApi);
    if (fields.requiresOpenaiAuth !== undefined) editProvider("requires_openai_auth", fields.requiresOpenaiAuth);
    if (fields.envKey !== undefined) editProvider("env_key", fields.envKey);
  }
  if (fields.bearer !== undefined && fields.bearer !== "keep") {
    editTop("experimental_bearer_token", fields.bearer === "remove" ? null : fields.bearer);
  }

  const nextText = lines.join("\n");
  assertNoReservedProviderBlock(nextText);
  return { text: nextText, changes };
}

function maskChanges(changes) {
  return changes.map((change) => {
    if (change.key !== "experimental_bearer_token") return change;
    return {
      ...change,
      before: change.before ? maskToken(change.before) : change.before,
      after: typeof change.after === "string" ? maskToken(change.after) : change.after
    };
  });
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
    const file = path.join(profileDir(home), `${entry.id}.toml`);
    const snapshot = await readTextIfPresent(file, null);
    profiles.push({
      id: entry.id,
      label: entry.label ?? entry.id,
      note: entry.note ?? "",
      kind: entry.kind ?? "custom",
      createdAt: entry.createdAt ?? null,
      missing: snapshot === null,
      active: snapshot !== null && snapshot === currentText
    });
  }
  return profiles.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function getConfigOverview(home) {
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  const summary = summarizeConfig(text);
  return {
    codexHome: home,
    configPath: configPath(home),
    exists: text.length > 0,
    raw: text,
    ...summary,
    kind: providerKind(summary.provider, summary.modelProvider),
    reservedBlocks: findReservedProviderBlocks(text),
    auth: await readAuthSummary(home),
    presets: buildPresets(summary),
    profiles: await listProfiles(home, text)
  };
}

async function saveProfile(home, { label, note = "", kind }) {
  if (!label) throw new Error("Profile label is required");
  const text = await readTextIfPresent(configPath(home), null);
  if (text === null) throw new Error("No config.toml found to capture");
  const id = `${timestamp()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.mkdir(profileDir(home), { recursive: true });
  await fs.writeFile(path.join(profileDir(home), `${id}.toml`), text);
  const summary = summarizeConfig(text);
  const profiles = await readProfileIndex(home);
  const entry = {
    id,
    label,
    note,
    kind: kind ?? providerKind(summary.provider, summary.modelProvider),
    createdAt: new Date().toISOString()
  };
  profiles.push(entry);
  await writeProfileIndex(home, profiles);
  return { saved: true, profile: entry };
}

async function deleteProfile(home, id, { execute }) {
  const profiles = await readProfileIndex(home);
  const entry = profiles.find((profile) => profile.id === id);
  if (!entry) throw new Error(`Profile not found: ${id}`);
  if (!execute) return { dryRun: true, profile: entry };
  await writeProfileIndex(home, profiles.filter((profile) => profile.id !== id));
  await fs.rm(path.join(profileDir(home), `${id}.toml`), { force: true });
  return { dryRun: false, deleted: true, profile: entry };
}

async function applyConfig(home, { fields, profileId }, { execute }) {
  const text = await readTextIfPresent(configPath(home), "") ?? "";

  if (profileId) {
    const entry = (await readProfileIndex(home)).find((profile) => profile.id === profileId);
    if (!entry) throw new Error(`Profile not found: ${profileId}`);
    const snapshot = await readTextIfPresent(path.join(profileDir(home), `${profileId}.toml`), null);
    if (snapshot === null) throw new Error(`Profile snapshot missing: ${profileId}`);
    if (!execute) {
      return { dryRun: true, mode: "profile", profile: entry, changes: [{ scope: "file", key: "config.toml", before: "(current config)", after: `profile "${entry.label}"` }] };
    }
    const backupDir = await createBackup(home, `config-profile:${profileId}`, []);
    await fs.writeFile(configPath(home), snapshot);
    return { dryRun: false, mode: "profile", profile: entry, backupDir };
  }

  const { text: nextText, changes } = applyConfigFields(text, fields ?? {});
  const masked = maskChanges(changes);
  if (!execute) {
    return { dryRun: true, mode: "fields", changes: masked };
  }
  if (!changes.length) {
    return { dryRun: false, mode: "fields", changes: [], noOp: true };
  }
  const backupDir = await createBackup(home, "config-fields", []);
  await fs.writeFile(configPath(home), nextText);
  return { dryRun: false, mode: "fields", changes: masked, backupDir };
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

async function fixReservedProviders(home, { toId = DEFAULT_RELAY_PROVIDER_ID, execute }) {
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

async function syncProviderTag(home, { toId, execute }) {
  const text = await readTextIfPresent(configPath(home), "") ?? "";
  const target = (toId && String(toId).trim()) || summarizeConfig(text).modelProvider;
  if (!target) {
    throw new Error("No target provider id; set model_provider in config.toml or pass --to <id>");
  }
  const reader = openDb(home, { readOnly: true });
  let groups;
  let total;
  try {
    groups = reader.prepare(
      "SELECT model_provider AS provider, COUNT(*) AS count FROM threads WHERE model_provider <> ? GROUP BY model_provider ORDER BY count DESC"
    ).all(target);
    total = groups.reduce((sum, group) => sum + Number(group.count), 0);
  } finally {
    reader.close();
  }

  if (!execute) {
    return { dryRun: true, target, groups, total };
  }
  if (!total) {
    return { dryRun: false, target, updated: 0, noOp: true };
  }

  const backupDir = await createBackup(home, `config-sync:${target}`, []);
  const db = openDb(home);
  let updated = 0;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const info = db.prepare("UPDATE threads SET model_provider = ? WHERE model_provider <> ?").run(target, target);
    db.exec("COMMIT");
    updated = Number(info.changes ?? total);
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
  return { dryRun: false, target, updated, groups, backupDir };
}

function printConfigSyncResult(result, execute) {
  printTitle(execute ? "Synced Chat Providers" : "Sync Preview");
  if (execute) {
    if (result.noOp) {
      console.log(`Nothing to sync; all chats already use "${result.target}".`);
      return;
    }
    printKeyValues([
      ["Target provider", result.target],
      ["Chats retagged", color(COLOR.green, result.updated)],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "none"]
    ]);
    if (result.backupDir) printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Target provider", result.target],
    ["Chats to retag", result.total]
  ]);
  if (result.groups?.length) {
    console.log("");
    printTable([
      { key: "provider", label: "From provider", width: 24 },
      { key: "count", label: "Chats", align: "right" }
    ], result.groups);
  }
  printNext("codex-chat-manager config-sync --yes");
}

function printConfigOverview(overview) {
  printTitle("Codex Config");
  printKeyValues([
    ["Codex home", compactPath(overview.codexHome)],
    ["Mode", overview.kind === "official"
      ? color(COLOR.green, "official")
      : overview.kind === "third-party"
        ? color(COLOR.yellow, "third-party")
        : color(COLOR.gray, overview.kind)],
    ["Model", overview.model ?? "-"],
    ["Provider", overview.modelProvider ?? "-"],
    ["Base URL", overview.provider?.baseUrl ?? "-"],
    ["Wire API", overview.provider?.wireApi ?? "-"],
    ["Requires OpenAI auth", String(overview.provider?.requiresOpenaiAuth ?? "-")],
    ["Bearer token", overview.bearer.present ? overview.bearer.masked : "none"],
    ["Auth mode", overview.auth.mode ?? "-"]
  ]);
  console.log("");
  printTitle("Presets");
  printTable([
    { key: "id", label: "Id", width: 12 },
    { key: "label", label: "Preset", width: 22 },
    { key: "baseUrl", label: "Base URL", width: 30 },
    { key: "auth", label: "OpenAI auth", width: 11 }
  ], overview.presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    baseUrl: preset.fields.baseUrl,
    auth: String(preset.fields.requiresOpenaiAuth)
  })));
  if (overview.profiles.length) {
    console.log("");
    printTitle("Saved profiles");
    printTable([
      { key: "id", label: "Id", width: 22 },
      { key: "label", label: "Label", width: 24 },
      { key: "kind", label: "Kind", width: 12 },
      { key: "active", label: "Active", width: 7 }
    ], overview.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      kind: profile.kind,
      active: profile.active ? "yes" : ""
    })));
  }
  printNext("codex-chat-manager config-apply --preset thirdparty");
}

function printConfigApplyResult(result, execute) {
  printTitle(execute ? "Config Updated" : "Config Change Preview");
  if (execute) {
    if (result.noOp) {
      console.log("No changes; config already matches.");
      return;
    }
    printKeyValues([
      ["Changed", color(COLOR.green, "yes")],
      ["Mode", result.mode],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "none"]
    ]);
    if (result.backupDir) printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
    return;
  }
  printKeyValues([["Mode", color(COLOR.yellow, "preview")], ["Type", result.mode]]);
  if (result.changes?.length) {
    console.log("");
    printTable([
      { key: "scope", label: "Scope", width: 9 },
      { key: "key", label: "Key", width: 26 },
      { key: "before", label: "Before", width: 24 },
      { key: "after", label: "After", width: 24 }
    ], result.changes.map((change) => ({
      scope: change.scope,
      key: change.key,
      before: change.before === null ? "(unset)" : String(change.before),
      after: change.after === null ? "(removed)" : String(change.after)
    })));
  } else {
    console.log(color(COLOR.gray, "No changes."));
  }
}

function configFieldsFromFlags(flags) {
  const fields = {};
  if (flags["base-url"] !== undefined) fields.baseUrl = String(flags["base-url"]);
  if (flags["wire-api"] !== undefined) fields.wireApi = String(flags["wire-api"]);
  if (flags["requires-auth"] !== undefined) fields.requiresOpenaiAuth = isTruthy(flags["requires-auth"]);
  if (flags.model !== undefined) fields.model = String(flags.model);
  if (flags["model-provider"] !== undefined) fields.modelProvider = String(flags["model-provider"]);
  if (flags["env-key"] !== undefined) fields.envKey = flags["env-key"] === "remove" ? null : String(flags["env-key"]);
  if (flags.bearer !== undefined) fields.bearer = flags.bearer === true ? "keep" : String(flags.bearer);
  return fields;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status) {
  const mismatchCount = (status.missingRolloutCount ?? 0) + (status.missingDbCount ?? 0) + (status.rolloutPathOutsideHomeCount ?? 0);
  printTitle("Codex Chat Manager Status");
  printKeyValues([
    ["Codex home", compactPath(status.codexHome)],
    ["SQLite", status.integrity === "ok" ? color(COLOR.green, "ok") : color(COLOR.red, status.integrity)],
    ["Chats", `${status.totals.threads ?? 0} total, ${status.totals.active ?? 0} active, ${status.totals.archived ?? 0} archived`],
    ["Interactive", status.totals.interactive ?? 0],
    ["Rollout files", status.rolloutFiles],
    ["Mismatches", mismatchCount === 0 ? color(COLOR.green, "0") : color(COLOR.yellow, mismatchCount)]
  ]);

  if (mismatchCount) {
    console.log("");
    printKeyValues([
      ["Missing rollouts", status.missingRolloutCount ?? 0],
      ["Rollouts missing DB", status.missingDbCount ?? 0],
      ["Paths outside home", status.rolloutPathOutsideHomeCount ?? 0]
    ]);
  }

  console.log("");
  printTitle("Providers");
  printTable([
    { key: "provider", label: "Provider", width: 24 },
    { key: "active", label: "Active", align: "right" },
    { key: "archived", label: "Archived", align: "right" },
    { key: "total", label: "Total", align: "right" },
    { key: "rollouts", label: "Files", align: "right" }
  ], providerSummaryRows(status), { empty: "No providers found." });
}

function providerSummaryRows(status) {
  const byProvider = new Map();
  for (const row of status.sqliteProviders ?? []) {
    const item = byProvider.get(row.model_provider) ?? { provider: row.model_provider, active: 0, archived: 0, total: 0, rollouts: 0 };
    if (Number(row.archived)) item.archived += Number(row.count) || 0;
    else item.active += Number(row.count) || 0;
    item.total += Number(row.count) || 0;
    byProvider.set(row.model_provider, item);
  }
  for (const [provider, count] of Object.entries(status.rolloutProviders ?? {})) {
    const item = byProvider.get(provider) ?? { provider, active: 0, archived: 0, total: 0, rollouts: 0 };
    item.rollouts = count;
    byProvider.set(provider, item);
  }
  return [...byProvider.values()].sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider));
}

function printProjects(projects) {
  printTitle("Projects");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "chats", label: "Chats", align: "right" },
    { key: "active", label: "Active", align: "right" },
    { key: "archived", label: "Arch", align: "right" },
    { key: "kind", label: "Kind", width: 10 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "path", label: "Project", width: 58 }
  ], projects.map((project, index) => ({
    index: `#${index + 1}`,
    chats: project.total,
    active: project.active,
    archived: project.archived,
    kind: project.saved ? "saved" : "discovered",
    updated: formatDate(project.updated_at),
    path: compactPath(project.path)
  })), { empty: "No projects found." });
  if (projects.length) {
    printNext("codex-chat-manager delete-project '#1'");
  }
}

function threadTableRows(threads) {
  return threads.map((thread) => ({
    ref: shortId(thread.id),
    state: thread.archived ? "archived" : "active",
    provider: thread.model_provider,
    updated: formatDate(thread.updated_at),
    project: compactPath(thread.cwd),
    title: thread.title || "(untitled)"
  }));
}

function printThreadTable(threads, { empty = "No chats match the current filters." } = {}) {
  printTable([
    { key: "ref", label: "Ref", width: 18 },
    { key: "state", label: "State", width: 8 },
    { key: "provider", label: "Provider", width: 16 },
    { key: "updated", label: "Updated", width: 16 },
    { key: "project", label: "Project", width: 34 },
    { key: "title", label: "Title", width: 34 }
  ], threadTableRows(threads), { empty });
}

function printThreads(threads, limit) {
  const visible = threads.slice(0, limit);
  printTitle("Chats");
  printThreadTable(visible);
  if (threads.length > visible.length) {
    console.log("");
    console.log(color(COLOR.gray, `${threads.length - visible.length} more hidden by --limit. Increase --limit to show more.`));
  }
  if (visible.length) {
    printNext(`codex-chat-manager delete-chat ${shortId(visible[0].id)}`);
  }
}

function printBackups(backups) {
  printTitle("Backups");
  printTable([
    { key: "index", label: "#", align: "right", width: 3 },
    { key: "created", label: "Created", width: 16 },
    { key: "threads", label: "Chats", align: "right" },
    { key: "reason", label: "Reason", width: 34 },
    { key: "path", label: "Backup", width: 56 }
  ], backups.map((backup, index) => ({
    index: `#${index + 1}`,
    created: formatIsoDate(backup.createdAt),
    threads: backup.threadIds.length,
    reason: backup.reason || "backup",
    path: compactPath(backup.path)
  })), { empty: "No chat-manager backups found." });
  if (backups.length) {
    printNext("codex-chat-manager restore '#1' --yes");
  }
}

function printMutationResult({ title, result, execute, previewCommand, executeCommand, emptyMessage }) {
  printTitle(title);
  if (execute) {
    if (result.noOp) {
      console.log(emptyMessage ?? "Nothing changed.");
      return;
    }
    printKeyValues([
      ["Changed", color(COLOR.green, "yes")],
      ["Chats", result.trashed ?? 0],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "none"]
    ]);
    if (result.backupDir) {
      printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
    }
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Chats", result.matchingThreadCount ?? result.threads?.length ?? 0],
    ["Backup", "will be created on --yes"]
  ]);
  if (result.project) {
    printKeyValues([["Project", compactPath(result.project)]]);
  }
  if (result.threads?.length || result.matchingThreads?.length) {
    const threads = result.threads ?? result.matchingThreads;
    console.log("");
    printTitle("Affected Chats");
    printThreadTable(threads.slice(0, 10), { empty: "No chats will be changed." });
    if (threads.length > 10) {
      console.log(color(COLOR.gray, `${threads.length - 10} more chats will also be changed.`));
    }
  }
  if (previewCommand) {
    console.log("");
    console.log(color(COLOR.gray, `Preview command: ${previewCommand}`));
  }
  printNext(executeCommand);
}

function printRestoreResult(result, execute) {
  printTitle(execute ? "Restored Backup" : "Restore Preview");
  if (execute) {
    printKeyValues([
      ["Backup", compactPath(result.backupDir)],
      ["Pre-restore backup", compactPath(result.preRestoreBackup)],
      ["Restored files", result.restoredFiles]
    ]);
    return;
  }
  printKeyValues([
    ["Mode", color(COLOR.yellow, "preview")],
    ["Backup", compactPath(result.backupDir)],
    ["Reason", result.metadata?.reason ?? "backup"],
    ["Chats", result.metadata?.threadIds?.length ?? 0],
    ["Created", formatIsoDate(result.metadata?.createdAt)]
  ]);
  printNext(`codex-chat-manager restore ${shellQuote(result.backupDir)} --yes`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (isTruthy(flags["no-color"])) {
    process.env.NO_COLOR = "1";
  }
  const command = normalizeCommand(positionals[0]);
  if (!command || command === "help" || isTruthy(flags.help)) {
    usage();
    return;
  }

  const home = codexHome(flags);
  const asJson = isTruthy(flags.json);
  const execute = isTruthy(flags.yes);

  if (command === "web") {
    const { startServer } = await import("./server.js");
    startServer({ port: parsePort(flags.port, 8765) });
    return;
  }

  if (command === "status") {
    const status = await getStatus(home);
    asJson ? printJson(status) : printStatus(status);
    return;
  }

  if (command === "projects") {
    const projects = await getProjects(home);
    asJson ? printJson(projects) : printProjects(projects);
    return;
  }

  if (command === "list") {
    const limit = parseLimit(flags.limit, 50);
    const threads = readThreads(home, flags);
    asJson ? printJson(threads) : printThreads(threads, limit);
    return;
  }

  if (command === "backups") {
    const backups = await listBackups(home);
    asJson ? printJson(backups) : printBackups(backups);
    return;
  }

  if (command === "trash-thread") {
    const id = positionals[1];
    if (!id) throw new Error("delete-chat requires a chat id or unique id prefix");
    const thread = readThreadByRef(home, id);
    if (!thread) throw new Error(`Chat not found: ${id}`);
    const result = await trashThreads(home, [thread], { execute, reason: `trash-thread:${id}` });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Chat" : "Delete Chat Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-chat ${shortId(thread.id)}`,
      executeCommand: `codex-chat-manager delete-chat ${shortId(thread.id)} --yes`
    });
    return;
  }

  if (command === "trash-provider") {
    const provider = positionals[1] ?? flags.provider;
    if (!provider) throw new Error("trash-provider requires a provider id");
    const threads = readThreads(home, { all: true, provider });
    const result = await trashThreads(home, threads, { execute, reason: `trash-provider:${provider}` });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Provider Chats" : "Delete Provider Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-provider ${shellQuote(provider)}`,
      executeCommand: `codex-chat-manager delete-provider ${shellQuote(provider)} --yes`,
      emptyMessage: "No chats found for this provider."
    });
    return;
  }

  if (command === "delete-project" || command === "remove-project") {
    const project = await resolveProjectRef(home, positionals[1] ?? flags.project);
    if (!project) throw new Error(`${command} requires a project path`);
    const result = await deleteProject(home, project, { execute });
    asJson ? printJson(result) : printMutationResult({
      title: execute ? "Deleted Project" : "Delete Project Preview",
      result,
      execute,
      previewCommand: `codex-chat-manager delete-project ${shellQuote(result.project)}`,
      executeCommand: `codex-chat-manager delete-project ${shellQuote(result.project)} --yes`,
      emptyMessage: "No matching project roots or chats found."
    });
    return;
  }

  if (command === "restore") {
    const backupDir = await resolveBackupRef(home, positionals[1] ?? flags.backup);
    if (!backupDir) throw new Error("restore requires a backup directory");
    const result = await restoreBackup(home, backupDir, execute);
    asJson ? printJson(result) : printRestoreResult(result, execute);
    return;
  }

  if (command === "config-show") {
    const overview = await getConfigOverview(home);
    asJson ? printJson(overview) : printConfigOverview(overview);
    return;
  }

  if (command === "config-apply") {
    let fields = configFieldsFromFlags(flags);
    if (flags.preset) {
      const overview = await getConfigOverview(home);
      const preset = overview.presets.find((item) => item.id === flags.preset);
      if (!preset) throw new Error(`Unknown preset: ${flags.preset}`);
      fields = { ...preset.fields, ...fields };
    }
    const profileId = typeof flags.profile === "string" ? flags.profile : undefined;
    if (!profileId && Object.keys(fields).length === 0) {
      throw new Error("config-apply needs --preset, --profile, or field flags");
    }
    const result = await applyConfig(home, { fields, profileId }, { execute });
    asJson ? printJson(result) : printConfigApplyResult(result, execute);
    return;
  }

  if (command === "config-file") {
    const data = await readConfigFile(home, typeof flags.file === "string" ? flags.file : "config");
    printJson(data);
    return;
  }

  if (command === "config-file-write") {
    const file = typeof flags.file === "string" ? flags.file : "config";
    const b64 = flags["content-b64"];
    if (typeof b64 !== "string") throw new Error("config-file-write requires --content-b64");
    const content = Buffer.from(b64, "base64").toString("utf8");
    const result = await writeConfigFile(home, file, content, { execute });
    asJson ? printJson(result) : printKeyValues([
      [result.dryRun ? "Would write" : "Wrote", result.path],
      ["Backup", result.backupDir ? compactPath(result.backupDir) : "n/a"]
    ]);
    return;
  }

  if (command === "config-fix") {
    const result = await fixReservedProviders(home, {
      toId: typeof flags.to === "string" ? flags.to : DEFAULT_RELAY_PROVIDER_ID,
      execute
    });
    asJson ? printJson(result) : (result.noOp
      ? console.log("No reserved built-in provider blocks found; nothing to fix.")
      : printConfigApplyResult({ mode: "fields", changes: result.changes, backupDir: result.backupDir, noOp: false }, execute));
    return;
  }

  if (command === "config-sync") {
    const result = await syncProviderTag(home, {
      toId: typeof flags.to === "string" ? flags.to : undefined,
      execute
    });
    asJson ? printJson(result) : printConfigSyncResult(result, execute);
    return;
  }

  if (command === "config-save-profile") {
    const label = positionals[1] ?? flags.label;
    if (!label) throw new Error("config-save-profile requires a label");
    const result = await saveProfile(home, {
      label,
      note: typeof flags.note === "string" ? flags.note : "",
      kind: typeof flags.kind === "string" ? flags.kind : undefined
    });
    asJson ? printJson(result) : printKeyValues([["Saved profile", result.profile.label], ["Id", result.profile.id]]);
    return;
  }

  if (command === "config-delete-profile") {
    const id = positionals[1] ?? flags.id;
    if (!id) throw new Error("config-delete-profile requires a profile id");
    const result = await deleteProfile(home, id, { execute });
    asJson ? printJson(result) : printKeyValues([
      [result.dryRun ? "Would delete" : "Deleted", result.profile.label],
      ["Id", result.profile.id]
    ]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
