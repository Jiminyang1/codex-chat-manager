import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.js");

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd: root,
    ...options
  });
}

async function makeFixture({ outsideRollout = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-chat-manager-"));
  const threadId = "019e0000-0000-7000-8000-000000000001";
  const project = path.join(home, "project");
  const rolloutRel = path.join("sessions", "2026", "05", "31", `rollout-2026-05-31T00-00-00-${threadId}.jsonl`);
  const rolloutPath = path.join(home, rolloutRel);
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.mkdir(path.join(home, "archived_sessions"), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  const meta = {
    timestamp: "2026-05-31T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp: "2026-05-31T00:00:00.000Z",
      cwd: project,
      originator: "Codex Desktop",
      cli_version: "0.test",
      source: "vscode",
      thread_source: "user",
      model_provider: "openai"
    }
  };
  await fs.writeFile(rolloutPath, `${JSON.stringify(meta)}\n{"type":"event_msg","payload":{"type":"user_message"}}\n`);

  const globalState = {
    "project-order": [project],
    "electron-saved-workspace-roots": [project],
    "active-workspace-roots": [project],
    "projectless-thread-ids": [threadId],
    "thread-workspace-root-hints": { [threadId]: project },
    "thread-projectless-output-directories": { [threadId]: path.join(project, "outputs") },
    "pinned-thread-ids": [threadId],
    "electron-persisted-atom-state": {
      "heartbeat-thread-permissions-by-id": { [threadId]: { approvalPolicy: "never" } },
      "unread-thread-ids-by-host-v1": { local: [threadId] }
    }
  };
  await fs.writeFile(path.join(home, ".codex-global-state.json"), JSON.stringify(globalState, null, 2));
  await fs.writeFile(path.join(home, "config.toml"), "model = \"gpt-5.5\"\n");

  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      thread_source TEXT
    );
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, PRIMARY KEY(thread_id, position));
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE agent_job_items (job_id TEXT NOT NULL, item_id TEXT NOT NULL, row_index INTEGER NOT NULL, row_json TEXT NOT NULL, status TEXT NOT NULL, assigned_thread_id TEXT, PRIMARY KEY(job_id, item_id));
  `);
  const storedRolloutPath = outsideRollout ? path.join(os.tmpdir(), "outside-rollout.jsonl") : rolloutPath;
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, preview, thread_source
    ) VALUES (?, ?, 1780000000, 1780000001, 'vscode', 'openai', ?, 'Fixture', '{}', 'never', 1, 'hello', 'hello', 'user')
  `).run(threadId, storedRolloutPath, project);
  db.close();
  return { home, threadId, project, rolloutPath };
}

test("trash-thread moves rollout, removes indexes, and restore recovers them", async () => {
  const fixture = await makeFixture();
  const trash = await runCli(["trash-thread", fixture.threadId, "--codex-home", fixture.home, "--yes", "--json"]);
  const result = JSON.parse(trash.stdout);
  assert.equal(result.trashed, 1);
  assert.equal(await exists(fixture.rolloutPath), false);
  assert.equal(await exists(result.moved[0].to), true);

  let db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count, 0);
  db.close();

  const state = JSON.parse(await fs.readFile(path.join(fixture.home, ".codex-global-state.json"), "utf8"));
  assert.deepEqual(state["projectless-thread-ids"], []);
  assert.equal(state["thread-workspace-root-hints"][fixture.threadId], undefined);

  await runCli(["restore", result.backupDir, "--codex-home", fixture.home, "--yes"]);
  assert.equal(await exists(fixture.rolloutPath), true);
  db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count, 1);
  db.close();
});

test("delete-project trashes exact-cwd threads by default and removes project roots", async () => {
  const fixture = await makeFixture();
  const deleted = await runCli(["delete-project", fixture.project, "--codex-home", fixture.home, "--yes", "--json"]);
  const result = JSON.parse(deleted.stdout);

  assert.equal(result.deletesChats, true);
  assert.equal(result.trashed, 1);
  assert.equal(result.matchingThreadCount, 1);
  assert.equal(result.removedProjectRefs, 3);
  assert.equal(await exists(fixture.rolloutPath), false);
  assert.equal(await exists(path.join(result.backupDir, "metadata.json")), true);

  const db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count, 0);
  db.close();

  const state = JSON.parse(await fs.readFile(path.join(fixture.home, ".codex-global-state.json"), "utf8"));
  assert.deepEqual(state["project-order"], []);
  assert.deepEqual(state["electron-saved-workspace-roots"], []);
  assert.deepEqual(state["active-workspace-roots"], []);
  assert.deepEqual(state["projectless-thread-ids"], []);
});

test("friendly aliases and short chat ids work", async () => {
  const fixture = await makeFixture();
  const list = await runCli(["chats", "--codex-home", fixture.home, "--no-color"]);
  assert.match(list.stdout, /Ref\s+State\s+Provider/);
  assert.match(list.stdout, /Fixture/);
  assert.match(list.stdout, /delete-chat/);

  const preview = await runCli(["delete-chat", fixture.threadId.slice(0, 18), "--codex-home", fixture.home, "--json"]);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.threads[0].id, fixture.threadId);
});

test("backups command lists backups and restore supports backup numbers", async () => {
  const fixture = await makeFixture();
  const deleted = await runCli(["rm-project", "#1", "--codex-home", fixture.home, "--yes", "--json"]);
  const deleteResult = JSON.parse(deleted.stdout);

  const backups = await runCli(["backups", "--codex-home", fixture.home, "--json"]);
  const backupRows = JSON.parse(backups.stdout);
  assert.equal(backupRows[0].path, deleteResult.backupDir);

  const restorePreview = await runCli(["restore", "#1", "--codex-home", fixture.home, "--json"]);
  const restoreResult = JSON.parse(restorePreview.stdout);
  assert.equal(restoreResult.dryRun, true);
  assert.equal(restoreResult.backupDir, deleteResult.backupDir);
});

test("mutation refuses rollout paths outside selected codex home", async () => {
  const fixture = await makeFixture({ outsideRollout: true });
  await assert.rejects(
    runCli(["trash-thread", fixture.threadId, "--codex-home", fixture.home, "--yes"]),
    /Refusing to operate on rollout outside Codex home/
  );
  assert.equal(await exists(fixture.rolloutPath), true);
});

const SAMPLE_CONFIG = `model_provider = "openai-custom"
model = "gpt-5.5"
experimental_bearer_token = "sk-secrettoken1234567890"

[model_providers.openai-custom]
name = "openai-custom"
base_url = "https://api.axis.fan"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.node_repl]
command = "/x/node_repl"

[projects."/Users/me/proj"]
trust_level = "trusted"
`;

async function makeConfigHome(config = SAMPLE_CONFIG) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccm-config-"));
  await fs.writeFile(path.join(home, "config.toml"), config);
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }));
  return home;
}

test("config-show reports active provider, kind, and presets", async () => {
  const home = await makeConfigHome();
  const { stdout } = await runCli(["config-show", "--codex-home", home, "--json"]);
  const overview = JSON.parse(stdout);
  assert.equal(overview.kind, "third-party");
  assert.equal(overview.provider.baseUrl, "https://api.axis.fan");
  assert.equal(overview.provider.requiresOpenaiAuth, false);
  assert.equal(overview.bearer.present, true);
  assert.ok(!overview.bearer.masked.includes("secrettoken"), "bearer token must be masked");
  assert.equal(overview.auth.mode, "chatgpt");
  assert.deepEqual(overview.presets.map((p) => p.id), ["official", "thirdparty"]);
});

test("config-apply official preset points at built-in openai with no custom block", async () => {
  const home = await makeConfigHome();
  const preview = JSON.parse((await runCli(["config-apply", "--preset", "official", "--codex-home", home, "--json"])).stdout);
  assert.equal(preview.dryRun, true);
  assert.ok(preview.changes.some((c) => c.key === "model_provider" && c.after === "openai"));

  await runCli(["config-apply", "--preset", "official", "--codex-home", home, "--json", "--yes"]);
  const after = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(after, /model_provider = "openai"/);
  assert.doesNotMatch(after, /\[model_providers\.openai\]/); // must NOT override the reserved built-in
  assert.match(after, /\[model_providers\.openai-custom\]/); // custom relay block left intact
  assert.match(after, /\[mcp_servers\.node_repl\]/);
  assert.match(after, /experimental_bearer_token = "sk-secrettoken1234567890"/);
});

test("config-apply thirdparty preset creates a custom provider block", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await runCli(["config-apply", "--preset", "thirdparty", "--codex-home", home, "--json", "--yes"]);
  const after = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(after, /model_provider = "openai-custom"/);
  assert.match(after, /\[model_providers\.openai-custom\]/);
  assert.match(after, /requires_openai_auth = false/);
});

test("config-fix renames a reserved [model_providers.openai] block and guards raw writes", async () => {
  const reserved = 'model_provider = "openai"\nmodel = "gpt-5.5"\n\n[model_providers.openai]\nname = "openai"\nbase_url = "https://api.axis.fan"\nrequires_openai_auth = false\n';
  const home = await makeConfigHome(reserved);

  const result = JSON.parse((await runCli(["config-fix", "--codex-home", home, "--json", "--yes"])).stdout);
  assert.ok(result.backupDir);
  const after = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(after, /\[model_providers\.openai-custom\]/);
  assert.doesNotMatch(after, /\[model_providers\.openai\]/);
  assert.match(after, /model_provider = "openai-custom"/);

  // Raw write guard refuses to re-introduce a reserved block.
  const badB64 = Buffer.from("[model_providers.openai]\n", "utf8").toString("base64");
  await assert.rejects(
    runCli(["config-file-write", "--codex-home", home, "--file", "config", "--content-b64", badB64, "--yes"]),
    /reserved built-in/
  );
});

test("config save, apply, and delete profile round-trips", async () => {
  const home = await makeConfigHome();
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);
  assert.equal(saved.saved, true);
  const profileId = saved.profile.id;

  // Switch live config to official, then restore the saved relay profile.
  await runCli(["config-apply", "--preset", "official", "--codex-home", home, "--json", "--yes"]);
  await runCli(["config-apply", "--profile", profileId, "--codex-home", home, "--json", "--yes"]);
  const restored = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(restored, /base_url = "https:\/\/api\.axis\.fan"/);

  const overview = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.equal(overview.profiles.find((p) => p.id === profileId)?.active, true);

  await runCli(["config-delete-profile", profileId, "--codex-home", home, "--json", "--yes"]);
  const afterDelete = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.equal(afterDelete.profiles.length, 0);
});

test("config-sync retags mismatched chats to the active provider", async () => {
  const fixture = await makeFixture(); // one thread tagged "openai"
  // Add a second thread under a different provider id.
  const db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"));
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, preview, thread_source
    ) VALUES ('019e0000-0000-7000-8000-000000000002', ?, 1780000002, 1780000003, 'vscode', 'OpenAI', ?, 'Second', '{}', 'never', 1, 'hi', 'hi', 'user')
  `).run(path.join(fixture.home, "sessions", "x.jsonl"), fixture.project);
  db.close();

  // Active provider id in config is "openai" (set by makeFixture's config.toml? no — set it).
  await fs.writeFile(path.join(fixture.home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');

  const preview = JSON.parse((await runCli(["config-sync", "--codex-home", fixture.home, "--json"])).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.target, "openai");
  assert.equal(preview.total, 1); // the "OpenAI" thread

  await runCli(["config-sync", "--codex-home", fixture.home, "--json", "--yes"]);
  const after = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  const distinct = after.prepare("SELECT DISTINCT model_provider AS p FROM threads").all().map((r) => r.p);
  after.close();
  assert.deepEqual(distinct, ["openai"]);
});

test("config-show exposes the full bearer token and api key for editing", async () => {
  const home = await makeConfigHome();
  const overview = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.equal(overview.bearer.value, "sk-secrettoken1234567890");
  assert.equal(overview.auth.apiKey, null);
});

test("config-file reads and config-file-write saves raw files with backup and JSON validation", async () => {
  const home = await makeConfigHome();

  const read = JSON.parse((await runCli(["config-file", "--codex-home", home, "--file", "config", "--json"])).stdout);
  assert.match(read.raw, /api\.axis\.fan/);

  // Write config.toml raw.
  const newConfig = 'model_provider = "openai"\nmodel = "gpt-5.5"\n';
  const b64 = Buffer.from(newConfig, "utf8").toString("base64");
  const write = JSON.parse((await runCli(["config-file-write", "--codex-home", home, "--file", "config", "--content-b64", b64, "--yes", "--json"])).stdout);
  assert.ok(write.backupDir);
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), newConfig);

  // auth.json must be valid JSON.
  const badB64 = Buffer.from("{ not json", "utf8").toString("base64");
  await assert.rejects(
    runCli(["config-file-write", "--codex-home", home, "--file", "auth", "--content-b64", badB64, "--yes"]),
    /not valid JSON/
  );
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
