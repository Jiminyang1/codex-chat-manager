#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeAction, safeCodexHome } from "./app-api.js";
import type { ActionName } from "./actions.cjs";
import type { JsonRecord } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isCompiledNodeServer = moduleDir.endsWith(path.join("dist", "node", "src"));
const rootDir = isCompiledNodeServer ? path.resolve(moduleDir, "..", "..") : path.resolve(moduleDir, "..");
const rendererDistDir = isCompiledNodeServer ? path.join(rootDir, "renderer") : path.join(rootDir, "dist", "renderer");
const defaultPort = Number.parseInt(process.env.PORT ?? "8765", 10);
const tokenHeader = "x-codex-manager-token";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(text);
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

function injectRuntimeConfig(html: string, securityToken: string): string {
  const script = `<script>window.__CODEX_MANAGER_TOKEN__=${JSON.stringify(securityToken)};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${script}\n</head>`) : `${script}\n${html}`;
}

async function readBody(req: http.IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function selectContentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function staticRoot() {
  try {
    const stat = await fs.stat(path.join(rendererDistDir, "index.html"));
    if (stat.isFile()) return rendererDistDir;
  } catch {
    // Development without a Vite build returns a clear setup message below.
  }
  return null;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, securityToken: string): Promise<void> {
  const root = await staticRoot();
  if (!root) {
    sendText(res, 503, "Run npm run build:renderer before npm run web, or use npm run electron:dev for development.");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(root, `.${requestPath}`);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    let content = await fs.readFile(resolved, "utf8");
    if (path.basename(resolved) === "index.html") {
      content = injectRuntimeConfig(content, securityToken);
    }
    sendText(res, 200, content, selectContentType(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function handleLegacyApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const queryHome = safeCodexHome(url.searchParams.get("codexHome"));
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, await invokeAction("status:get", { codexHome: queryHome }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, await invokeAction("projects:list", { codexHome: queryHome }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/threads") {
    const action = url.searchParams.get("projectless") === "1" ? "projectlessThreads:list" : "threads:list";
    sendJson(res, 200, await invokeAction(action, {
      codexHome: queryHome,
      project: url.searchParams.get("project") || "",
      provider: url.searchParams.get("provider") || "",
      archived: url.searchParams.get("archived") === "1"
    }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/backups") {
    sendJson(res, 200, await invokeAction("backups:list", { codexHome: queryHome }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, await invokeAction("config:get", { codexHome: queryHome }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/profile/file") {
    sendJson(res, 200, await invokeAction("profile:file:get", {
      codexHome: queryHome,
      profileId: url.searchParams.get("profileId"),
      file: url.searchParams.get("file")
    }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/config/file") {
    sendJson(res, 200, await invokeAction("config:file:get", {
      codexHome: queryHome,
      file: url.searchParams.get("file")
    }));
    return true;
  }
  const routeMap: Record<string, ActionName> = {
    "/api/trash-thread": "thread:trash",
    "/api/delete-project": "project:delete",
    "/api/restore": "backup:restore",
    "/api/delete-backup": "backup:delete",
    "/api/profile/switch": "profile:switch",
    "/api/profile/file": "profile:file:write",
    "/api/provider/create": "provider:create",
    "/api/provider/use-official": "provider:useOfficial",
    "/api/config/file": "config:file:write",
    "/api/config/fix": "config:fix",
    "/api/config/sync": "config:sync",
    "/api/config/save-profile": "profile:save",
    "/api/config/delete-profile": "profile:delete"
  };
  const action = routeMap[url.pathname];
  if (req.method === "POST" && action) {
    sendJson(res, 200, await invokeAction(action, await readBody(req)));
    return true;
  }
  return false;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, securityToken: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST") {
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: "API POST requests must use application/json." });
      return;
    }
    if (req.headers[tokenHeader] !== securityToken) {
      sendJson(res, 403, { error: "Invalid API token." });
      return;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/action") {
    const body = await readBody(req);
    sendJson(res, 200, await invokeAction(String(body.action), body.payload ?? {}));
    return;
  }
  if (await handleLegacyApi(req, res, url)) return;
  sendJson(res, 404, { error: "Unknown API route" });
}

export function startServer({
  host = "127.0.0.1",
  port = defaultPort,
  securityToken = randomBytes(32).toString("base64url")
}: { host?: string; port?: number; securityToken?: string } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res, securityToken);
        return;
      }
      await serveStatic(req, res, securityToken);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`codex-chat-manager web UI: http://${host}:${actualPort}`);
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
