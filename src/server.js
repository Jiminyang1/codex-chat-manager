#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const cliPath = path.join(rootDir, "src", "cli.js");
const defaultCodexHome = path.join(os.homedir(), ".codex");
const defaultPort = Number.parseInt(process.env.PORT ?? "8765", 10);

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res, status, body) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(text);
}

function safeCodexHome(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultCodexHome;
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function runCli(args, { json = true } = {}) {
  const finalArgs = [cliPath, ...args];
  const { stdout, stderr } = await execFileAsync(process.execPath, finalArgs, {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 20
  });
  if (json) {
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  return { stdout, stderr };
}

function argsWithHome(command, codexHome) {
  return [command, "--codex-home", codexHome];
}

async function listBackups(codexHome) {
  const root = path.join(codexHome, "backups_state", "chat-manager");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    let metadata = null;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(fullPath, "metadata.json"), "utf8"));
    } catch {
      metadata = null;
    }
    const stat = await fs.stat(fullPath);
    backups.push({
      name: entry.name,
      path: fullPath,
      createdAt: metadata?.createdAt ?? stat.mtime.toISOString(),
      reason: metadata?.reason ?? "",
      threadIds: metadata?.threadIds ?? []
    });
  }
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return backups;
}

function selectContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(publicDir, `.${requestPath}`);
  if (!resolved.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    sendText(res, 200, await fs.readFile(resolved, "utf8"), selectContentType(resolved));
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

function requireConfirm(body, expected) {
  return body?.confirmed === true || body?.confirm === expected;
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const codexHome = safeCodexHome(url.searchParams.get("codexHome"));

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, await runCli([...argsWithHome("status", codexHome), "--json"]));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, await runCli([...argsWithHome("projects", codexHome), "--json"]));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/threads") {
    const args = [...argsWithHome("list", codexHome), "--json", "--all"];
    for (const [param, flag] of [["project", "--project"], ["provider", "--provider"]]) {
      const value = url.searchParams.get(param);
      if (value) args.push(flag, value);
    }
    if (url.searchParams.get("archived") === "1") {
      args.push("--archived");
    }
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    sendJson(res, 200, await listBackups(codexHome));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trash-thread") {
    const body = await readBody(req);
    if (!body.threadId) throw new Error("threadId is required");
    const args = [...argsWithHome("trash-thread", safeCodexHome(body.codexHome)), body.threadId, "--json"];
    if (requireConfirm(body, "TRASH")) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/delete-project") {
    const body = await readBody(req);
    if (!body.project) throw new Error("project is required");
    const args = [...argsWithHome("delete-project", safeCodexHome(body.codexHome)), body.project, "--json"];
    if (requireConfirm(body, "DELETE")) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trash-provider") {
    const body = await readBody(req);
    if (!body.provider) throw new Error("provider is required");
    const args = [...argsWithHome("trash-provider", safeCodexHome(body.codexHome)), body.provider, "--json"];
    if (requireConfirm(body, "TRASH")) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, await runCli([...argsWithHome("config-show", codexHome), "--json"]));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/apply") {
    const body = await readBody(req);
    const args = [...argsWithHome("config-apply", safeCodexHome(body.codexHome)), "--json"];
    if (typeof body.preset === "string") args.push("--preset", body.preset);
    if (typeof body.profile === "string") args.push("--profile", body.profile);
    const fields = body.fields ?? {};
    const fieldFlags = {
      baseUrl: "--base-url",
      wireApi: "--wire-api",
      model: "--model",
      modelProvider: "--model-provider",
      envKey: "--env-key",
      bearer: "--bearer"
    };
    for (const [name, flag] of Object.entries(fieldFlags)) {
      if (fields[name] !== undefined && fields[name] !== null) args.push(flag, String(fields[name]));
    }
    if (fields.requiresOpenaiAuth !== undefined) {
      args.push("--requires-auth", fields.requiresOpenaiAuth ? "true" : "false");
    }
    if (body.confirmed === true) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/file") {
    const file = url.searchParams.get("file") === "auth" ? "auth" : "config";
    sendJson(res, 200, await runCli([...argsWithHome("config-file", codexHome), "--file", file, "--json"]));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/file") {
    const body = await readBody(req);
    const file = body.file === "auth" ? "auth" : "config";
    if (typeof body.content !== "string") throw new Error("content is required");
    const b64 = Buffer.from(body.content, "utf8").toString("base64");
    const args = [...argsWithHome("config-file-write", safeCodexHome(body.codexHome)), "--file", file, "--content-b64", b64, "--json"];
    if (body.confirmed === true) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/fix") {
    const body = await readBody(req);
    const args = [...argsWithHome("config-fix", safeCodexHome(body.codexHome)), "--json"];
    if (typeof body.to === "string" && body.to) args.push("--to", body.to);
    if (body.confirmed === true) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/sync") {
    const body = await readBody(req);
    const args = [...argsWithHome("config-sync", safeCodexHome(body.codexHome)), "--json"];
    if (typeof body.to === "string" && body.to) args.push("--to", body.to);
    if (body.confirmed === true) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/save-profile") {
    const body = await readBody(req);
    if (!body.label) throw new Error("label is required");
    const args = [...argsWithHome("config-save-profile", safeCodexHome(body.codexHome)), body.label, "--json"];
    if (body.note) args.push("--note", String(body.note));
    if (body.kind) args.push("--kind", String(body.kind));
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/delete-profile") {
    const body = await readBody(req);
    if (!body.id) throw new Error("id is required");
    const args = [...argsWithHome("config-delete-profile", safeCodexHome(body.codexHome)), body.id, "--json"];
    if (body.confirmed === true) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/restore") {
    const body = await readBody(req);
    if (!body.backupDir) throw new Error("backupDir is required");
    const args = [...argsWithHome("restore", safeCodexHome(body.codexHome)), body.backupDir, "--json"];
    if (requireConfirm(body, "RESTORE")) args.push("--yes");
    sendJson(res, 200, await runCli(args));
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

export function startServer({ host = "127.0.0.1", port = defaultPort } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res);
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(port, host, () => {
    console.log(`codex-chat-manager web UI: http://${host}:${port}`);
  });
  return server;
}

function isDirectRun() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return path.resolve(argvPath) === modulePath;
  }
}

if (isDirectRun()) {
  startServer();
}
