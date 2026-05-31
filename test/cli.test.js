import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { invokeAction } from "../src/app-api.js";

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

test("projects are saved workspace roots and projectless chats are separate", async () => {
  const fixture = await makeFixture();
  const transientId = "019e0000-0000-7000-8000-000000000099";
  const transientCwd = path.join(fixture.home, "transient-chat");
  const transientRollout = path.join(fixture.home, "sessions", "transient.jsonl");
  await fs.writeFile(transientRollout, "{}\n");
  const db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"));
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, preview, thread_source
    ) VALUES (?, ?, 1780000002, 1780000003, 'vscode', 'openai', ?, 'Loose Chat', '{}', 'never', 1, 'loose', 'loose', 'user')
  `).run(transientId, transientRollout, transientCwd);
  db.close();
  const state = JSON.parse(await fs.readFile(path.join(fixture.home, ".codex-global-state.json"), "utf8"));
  state["projectless-thread-ids"] = [transientId];
  await fs.writeFile(path.join(fixture.home, ".codex-global-state.json"), JSON.stringify(state, null, 2));

  const projects = JSON.parse((await runCli(["projects", "--codex-home", fixture.home, "--json"])).stdout);
  assert.deepEqual(projects.map((project) => project.path), [fixture.project]);

  const projectless = await invokeAction("projectlessThreads:list", { codexHome: fixture.home });
  assert.deepEqual(projectless.map((thread) => thread.id), [transientId]);
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

  await fs.writeFile(path.join(fixture.home, "state_5.sqlite-wal"), "stale wal");
  await runCli(["restore", "#1", "--codex-home", fixture.home, "--json", "--yes"]);
  assert.equal(await exists(path.join(fixture.home, "state_5.sqlite-wal")), false);
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

test("config-show reports active provider, kind, and profiles (no presets)", async () => {
  const home = await makeConfigHome();
  const { stdout } = await runCli(["config-show", "--codex-home", home, "--json"]);
  const overview = JSON.parse(stdout);
  assert.equal(overview.kind, "third-party");
  assert.equal(overview.provider.baseUrl, "https://api.axis.fan");
  assert.equal(overview.provider.requiresOpenaiAuth, false);
  assert.equal(overview.bearer.present, true);
  assert.ok(!overview.bearer.masked.includes("secrettoken"), "bearer token must be masked");
  assert.equal(overview.auth.mode, "chatgpt");
  // No presets key; profiles array is present.
  assert.ok(!overview.presets, "presets key should be absent in new model");
  assert.ok(Array.isArray(overview.profiles));
});

test("save-profile captures both config.toml and auth.json", async () => {
  const home = await makeConfigHome();
  const saved = JSON.parse((await runCli(["config-save-profile", "relay-with-auth", "--codex-home", home, "--json"])).stdout);
  assert.equal(saved.saved, true);
  assert.equal(saved.profile.hasAuth, true);

  // Verify both files were written into the profile directory.
  const profileDir = path.join(home, "chat-manager-profiles");
  assert.equal(await exists(path.join(profileDir, `${saved.profile.id}.toml`)), true);
  assert.equal(await exists(path.join(profileDir, `${saved.profile.id}.auth.json`)), true);

  // The auth.json snapshot matches the original.
  const authSnapshot = JSON.parse(await fs.readFile(path.join(profileDir, `${saved.profile.id}.auth.json`), "utf8"));
  assert.equal(authSnapshot.auth_mode, "chatgpt");
});

test("save-profile without auth.json records hasAuth:false", async () => {
  const home = await makeConfigHome();
  await fs.rm(path.join(home, "auth.json"), { force: true });
  const saved = JSON.parse((await runCli(["config-save-profile", "no-auth", "--codex-home", home, "--json"])).stdout);
  assert.equal(saved.saved, true);
  assert.equal(saved.profile.hasAuth, false);
  assert.equal(await exists(path.join(home, "chat-manager-profiles", `${saved.profile.id}.auth.json`)), false);
});

test("profile-switch writes config.toml and auth.json from a saved profile", async () => {
  const home = await makeConfigHome();
  // Save a profile capturing current third-party config + auth.
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);

  // Switch to a different config first (just a basic official config).
  await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));

  // Now switch to the saved relay profile.
  const result = JSON.parse((await runCli(["profile-switch", saved.profile.id, "--codex-home", home, "--json", "--yes"])).stdout);
  assert.equal(result.dryRun, false);
  assert.equal(result.wroteConfig, true);
  assert.equal(result.wroteAuth, true);

  // config.toml is restored.
  const afterConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(afterConfig, /base_url = "https:\/\/api\.axis\.fan"/);
  assert.match(afterConfig, /requires_openai_auth = false/);

  // auth.json is restored.
  const afterAuth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
  assert.equal(afterAuth.auth_mode, "chatgpt");
});

test("profile-switch without auth snapshot writes config but skips auth", async () => {
  const home = await makeConfigHome();
  // Save a relay profile, then remove its auth snapshot to simulate an old profile.
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);
  await fs.rm(path.join(home, "chat-manager-profiles", `${saved.profile.id}.auth.json`), { force: true });

  // Set a known auth.json.
  const knownAuth = JSON.stringify({ auth_mode: "known-state" });
  await fs.writeFile(path.join(home, "auth.json"), knownAuth);
  await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');

  const result = JSON.parse((await runCli(["profile-switch", saved.profile.id, "--codex-home", home, "--json", "--yes"])).stdout);
  assert.equal(result.wroteConfig, true);
  assert.equal(result.wroteAuth, false);

  // config.toml was overwritten by the profile.
  const afterConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(afterConfig, /openai-custom/);

  // auth.json was left alone.
  const afterAuth = await fs.readFile(path.join(home, "auth.json"), "utf8");
  assert.equal(afterAuth, knownAuth);
});

test("profile-switch dry-run previews changes without writing", async () => {
  const home = await makeConfigHome();
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);

  const originalConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
  const originalAuth = await fs.readFile(path.join(home, "auth.json"), "utf8");

  const preview = JSON.parse((await runCli(["profile-switch", saved.profile.id, "--codex-home", home, "--json"])).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.profile.id, saved.profile.id);
  assert.ok(preview.changes.some((c) => c.file === "config.toml"));
  assert.ok(preview.changes.some((c) => c.file === "auth.json"));

  // Nothing was written.
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), originalConfig);
  assert.equal(await fs.readFile(path.join(home, "auth.json"), "utf8"), originalAuth);
});

test("profile round-trip: save → switch away → switch back restores both files", async () => {
  const home = await makeConfigHome();
  const originalConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
  const originalAuth = await fs.readFile(path.join(home, "auth.json"), "utf8");

  // Save the current state as profile "A".
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);

  // Change to official config.
  await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "different" }));

  // Save that as profile "B".
  const savedB = JSON.parse((await runCli(["config-save-profile", "official", "--codex-home", home, "--json"])).stdout);

  // Switch back to profile A.
  await runCli(["profile-switch", saved.profile.id, "--codex-home", home, "--json", "--yes"]);

  // Both files match the original.
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), originalConfig);
  assert.equal(await fs.readFile(path.join(home, "auth.json"), "utf8"), originalAuth);

  // Switch to profile B and verify.
  await runCli(["profile-switch", savedB.profile.id, "--codex-home", home, "--json", "--yes"]);
  assert.match(await fs.readFile(path.join(home, "config.toml"), "utf8"), /model_provider = "openai"/);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")).auth_mode, "different");
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

test("config save, profile switch, and delete profile round-trips", async () => {
  const home = await makeConfigHome();
  const saved = JSON.parse((await runCli(["config-save-profile", "relay", "--codex-home", home, "--json"])).stdout);
  assert.equal(saved.saved, true);
  const profileId = saved.profile.id;

  // Save a second profile with official config.
  const officialHome = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  const savedOfficial = JSON.parse((await runCli(["config-save-profile", "official", "--codex-home", officialHome, "--json"])).stdout);
  const officialProfileId = savedOfficial.profile.id;

  // Switch away from relay to official profile (just to verify switching).
  await runCli(["profile-switch", profileId, "--codex-home", home, "--json", "--yes"]);
  const restored = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(restored, /base_url = "https:\/\/api\.axis\.fan"/);

  const overview = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.ok(overview.profiles.find((p) => p.id === profileId));

  await runCli(["config-delete-profile", profileId, "--codex-home", home, "--json", "--yes"]);
  const afterDelete = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.equal(afterDelete.profiles.find((p) => p.id === profileId), undefined);
});

test("config-sync retags mismatched chats to the active provider", async () => {
  const fixture = await makeFixture(); // one thread tagged "openai"
  // Add a second thread under a different provider id.
  const secondThreadId = "019e0000-0000-7000-8000-000000000002";
  const secondRollout = path.join(fixture.home, "sessions", "x.jsonl");
  await fs.writeFile(secondRollout, `${JSON.stringify({
    timestamp: "2026-05-31T00:00:01.000Z",
    type: "session_meta",
    payload: {
      id: secondThreadId,
      timestamp: "2026-05-31T00:00:01.000Z",
      cwd: fixture.project,
      source: "vscode",
      thread_source: "user",
      model_provider: "OpenAI"
    }
  })}\n{"type":"event_msg","payload":{"type":"user_message"}}\n`);
  const db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"));
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, preview, thread_source
    ) VALUES ('019e0000-0000-7000-8000-000000000002', ?, 1780000002, 1780000003, 'vscode', 'OpenAI', ?, 'Second', '{}', 'never', 1, 'hi', 'hi', 'user')
  `).run(secondRollout, fixture.project);
  db.close();

  // Active provider id in config is "openai" (set by makeFixture's config.toml? no — set it).
  await fs.writeFile(path.join(fixture.home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');

  const preview = JSON.parse((await runCli(["config-sync", "--codex-home", fixture.home, "--json"])).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.target, "openai");
  assert.equal(preview.total, 1); // the "OpenAI" thread

  const result = JSON.parse((await runCli(["config-sync", "--codex-home", fixture.home, "--json", "--yes"])).stdout);
  assert.equal(result.dbUpdated, 1);
  assert.equal(result.rolloutUpdated, 1);
  const after = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  const distinct = after.prepare("SELECT DISTINCT model_provider AS p FROM threads").all().map((r) => r.p);
  after.close();
  assert.deepEqual(distinct, ["openai"]);
  const secondMeta = JSON.parse((await fs.readFile(secondRollout, "utf8")).split("\n")[0]);
  assert.equal(secondMeta.payload.model_provider, "openai");
});

test("config-sync repairs rollout-only provider mismatches", async () => {
  const fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  const lines = (await fs.readFile(fixture.rolloutPath, "utf8")).split("\n");
  const meta = JSON.parse(lines[0]);
  meta.payload.model_provider = "OpenAI";
  lines[0] = JSON.stringify(meta);
  await fs.writeFile(fixture.rolloutPath, lines.join("\n"));

  const status = await invokeAction("status:get", { codexHome: fixture.home });
  assert.equal(status.providerSyncMismatchCount, 1);

  const preview = JSON.parse((await runCli(["config-sync", "--codex-home", fixture.home, "--json"])).stdout);
  assert.equal(preview.total, 1);

  const result = JSON.parse((await runCli(["config-sync", "--codex-home", fixture.home, "--json", "--yes"])).stdout);
  assert.equal(result.dbUpdated, 0);
  assert.equal(result.rolloutUpdated, 1);
  const afterMeta = JSON.parse((await fs.readFile(fixture.rolloutPath, "utf8")).split("\n")[0]);
  assert.equal(afterMeta.payload.model_provider, "openai");
});

test("config-sync repair mode does not merge provider tags", async () => {
  const fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  const lines = (await fs.readFile(fixture.rolloutPath, "utf8")).split("\n");
  const meta = JSON.parse(lines[0]);
  meta.payload.model_provider = "axis";
  lines[0] = JSON.stringify(meta);
  await fs.writeFile(fixture.rolloutPath, lines.join("\n"));

  const preview = JSON.parse((await runCli(["config-sync", "--mode", "repair", "--codex-home", fixture.home, "--json"])).stdout);
  assert.equal(preview.mode, "repair");
  assert.equal(preview.total, 1);

  const result = JSON.parse((await runCli(["config-sync", "--mode", "repair", "--codex-home", fixture.home, "--json", "--yes"])).stdout);
  assert.equal(result.mode, "repair");
  assert.equal(result.dbUpdated, 1);
  assert.equal(result.rolloutUpdated, 0);
  const db = new DatabaseSync(path.join(fixture.home, "state_5.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT model_provider FROM threads WHERE id = ?").get(fixture.threadId).model_provider, "axis");
  db.close();
  const afterMeta = JSON.parse((await fs.readFile(fixture.rolloutPath, "utf8")).split("\n")[0]);
  assert.equal(afterMeta.payload.model_provider, "axis");
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

test("provider:create saves user-edited raw config and auth profile files", async () => {
  const home = await makeConfigHome();
  const rawConfig = 'model_provider = "axis"\nmodel = "gpt-5.5"\n\n[model_providers.axis]\nname = "axis"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\n';
  const rawAuth = '{\n  "OPENAI_API_KEY": "sk-axis"\n}\n';
  const result = await invokeAction("provider:create", {
    codexHome: home,
    label: "Axis",
    configText: rawConfig,
    authText: rawAuth,
    switch: false
  });

  assert.equal(result.saved, true);
  assert.equal(result.switched, false);
  assert.equal(result.profile.providerId, "axis");
  const profileDir = path.join(home, "chat-manager-profiles");
  const configText = await fs.readFile(path.join(profileDir, `${result.profile.id}.toml`), "utf8");
  const auth = JSON.parse(await fs.readFile(path.join(profileDir, `${result.profile.id}.auth.json`), "utf8"));
  assert.equal(configText, rawConfig);
  assert.equal(auth.OPENAI_API_KEY, "sk-axis");
});

test("provider:create derives provider id from raw config", async () => {
  const home = await makeConfigHome();
  const rawConfig = 'model_provider = "openai-custom"\nmodel = "gpt-5.5"\n\n[model_providers.openai-custom]\nname = "openai-custom"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\n';
  const result = await invokeAction("provider:create", {
    codexHome: home,
    label: "axis",
    configText: rawConfig,
    authText: '{ "OPENAI_API_KEY": "sk-axis" }\n',
    switch: false
  });

  assert.equal(result.profile.providerId, "openai-custom");
});

test("provider:create rejects invalid auth JSON", async () => {
  const home = await makeConfigHome();
  await assert.rejects(
    invokeAction("provider:create", {
      codexHome: home,
      label: "Axis",
      configText: 'model_provider = "axis"\n\n[model_providers.axis]\nname = "axis"\nbase_url = "https://api.axis.fan"\n',
      authText: "{ not json",
      switch: false
    }),
    /authText is not valid JSON/
  );
});

test("custom Codex provider remains third-party when requires_openai_auth is true", async () => {
  const home = await makeConfigHome('model_provider = "axis"\nmodel = "gpt-5.5"\n\n[model_providers.axis]\nname = "axis"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  const overview = JSON.parse((await runCli(["config-show", "--codex-home", home, "--json"])).stdout);
  assert.equal(overview.kind, "third-party");
});

test("config:get auto-adds the current third-party provider without duplicating it", async () => {
  const home = await makeConfigHome('model_provider = "axis"\nmodel = "gpt-5.5"\n\n[model_providers.axis]\nname = "axis"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\n');

  const first = await invokeAction("config:get", { codexHome: home });
  const second = await invokeAction("config:get", { codexHome: home });

  assert.equal(first.autoThirdPartyProfile.profile.id, "current-provider-axis");
  assert.equal(second.autoThirdPartyProfile.profile.id, "current-provider-axis");
  assert.equal(second.profiles.filter((profile) => profile.id === "current-provider-axis").length, 1);
  assert.equal(await exists(path.join(home, "chat-manager-profiles", "current-provider-axis.toml")), true);
  assert.equal(await exists(path.join(home, "chat-manager-profiles", "current-provider-axis.auth.json")), true);
});

test("reserved openai provider block is not treated as OpenAI Official", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n\n[model_providers.openai]\nname = "openai"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const overview = await invokeAction("config:get", { codexHome: home });

  assert.equal(overview.kind, "third-party");
  assert.equal(overview.autoOfficialSnapshot.saved, false);
  assert.equal(overview.autoOfficialSnapshot.reason, "not-official-config");
  assert.equal(await exists(path.join(home, "chat-manager-profiles", "openai-official.toml")), false);
});

test("provider:useOfficial writes provider defaults without creating a backup", async () => {
  const home = await makeConfigHome();
  const result = await invokeAction("provider:useOfficial", { codexHome: home, confirmed: true });
  assert.equal(result.dryRun, false);
  assert.equal(result.backupDir, undefined);
  const afterConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.match(afterConfig, /model_provider = "openai"/);
  assert.doesNotMatch(afterConfig, /experimental_bearer_token/);
  assert.match(afterConfig, /\[mcp_servers\.node_repl\]/);
  assert.match(afterConfig, /\[projects\."\/Users\/me\/proj"\]/);
});

test("config:get auto-saves current OpenAI Official config and auth snapshot", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));

  const overview = await invokeAction("config:get", { codexHome: home });

  assert.equal(overview.officialAuthSnapshot.source, "profile");
  assert.equal(overview.officialAuthSnapshot.profileId, "openai-official");
  assert.equal(overview.officialAuthSnapshot.autoManaged, true);
  const profileDir = path.join(home, "chat-manager-profiles");
  assert.match(await fs.readFile(path.join(profileDir, "openai-official.toml"), "utf8"), /model_provider = "openai"/);
  assert.equal(JSON.parse(await fs.readFile(path.join(profileDir, "openai-official.auth.json"), "utf8")).auth_mode, "chatgpt");
  assert.equal(overview.profiles.some((profile) => profile.id === "openai-official"), false);
});

test("config:get treats implicit OpenAI config with ChatGPT auth as official", async () => {
  const home = await makeConfigHome('model = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));

  const overview = await invokeAction("config:get", { codexHome: home });

  assert.equal(overview.modelProvider, "openai");
  assert.equal(overview.configuredModelProvider, null);
  assert.equal(overview.kind, "official");
  assert.equal(overview.officialAuthSnapshot.source, "profile");
  assert.equal(overview.officialAuthSnapshot.profileId, "openai-official");
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "chat-manager-profiles", "openai-official.auth.json"), "utf8")).auth_mode, "chatgpt");
});

test("auto-saved OpenAI Official backup cannot be deleted", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  await invokeAction("config:get", { codexHome: home });

  await assert.rejects(
    invokeAction("profile:delete", { codexHome: home, id: "openai-official", confirmed: true }),
    /managed automatically/
  );
  assert.equal(await exists(path.join(home, "chat-manager-profiles", "openai-official.toml")), true);
  assert.equal(await exists(path.join(home, "chat-manager-profiles", "openai-official.auth.json")), true);
});

test("provider:useOfficial restores auth from auto-saved official snapshot", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  await invokeAction("config:get", { codexHome: home });

  await fs.writeFile(path.join(home, "config.toml"), SAMPLE_CONFIG);
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-axis" }));
  const result = await invokeAction("provider:useOfficial", { codexHome: home, confirmed: true });

  assert.equal(result.wroteAuth, true);
  assert.equal(result.authSource.profileId, "openai-official");
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")).auth_mode, "chatgpt");
});

test("provider:useOfficial restores auth.json from saved official profile", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  await runCli(["config-save-profile", "official", "--codex-home", home, "--kind", "official", "--json"]);

  await fs.writeFile(path.join(home, "config.toml"), SAMPLE_CONFIG);
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-axis" }));
  const result = await invokeAction("provider:useOfficial", { codexHome: home, confirmed: true });

  assert.equal(result.wroteAuth, true);
  assert.equal(result.authSource.label, "official");
  const afterAuth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
  assert.equal(afterAuth.auth_mode, "chatgpt");
  assert.equal(afterAuth.OPENAI_API_KEY, undefined);
});

test("provider:useOfficial refuses to switch when official auth was overwritten and no snapshot exists", async () => {
  const home = await makeConfigHome();
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-axis" }));
  await assert.rejects(
    invokeAction("provider:useOfficial", { codexHome: home, confirmed: true }),
    /No OpenAI Official auth snapshot/
  );
});

test("provider:officialFiles falls back to official config from backups", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  const backupDir = (await invokeAction("config:file:write", {
    codexHome: home,
    file: "config",
    content: 'model_provider = "openai-custom"\nmodel = "gpt-5.5"\n',
    confirmed: true
  })).backupDir;
  await fs.rm(path.join(backupDir, "auth.json"), { force: true });

  const files = await invokeAction("provider:officialFiles", { codexHome: home });
  assert.equal(files.source, "backup");
  assert.equal(files.hasAuth, true);
  assert.equal(files.authSource, "current");
  assert.match(files.config, /model_provider = "openai"/);
  assert.equal(JSON.parse(files.auth).auth_mode, "chatgpt");
});

test("provider:useOfficial can restore official config and auth from backup", async () => {
  const home = await makeConfigHome('model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const backupDir = (await invokeAction("config:file:write", {
    codexHome: home,
    file: "config",
    content: SAMPLE_CONFIG,
    confirmed: true
  })).backupDir;
  await fs.rm(path.join(home, "chat-manager-profiles"), { recursive: true, force: true });
  await fs.rm(path.join(home, "auth.json"), { force: true });

  const files = await invokeAction("provider:officialFiles", { codexHome: home });
  assert.equal(files.source, "backup");
  assert.equal(files.hasOfficialAuth, true);

  const result = await invokeAction("provider:useOfficial", { codexHome: home, confirmed: true });
  assert.equal(result.wroteAuth, true);
  assert.equal(result.authSource.source, "backup");
  assert.match(await fs.readFile(path.join(home, "config.toml"), "utf8"), /model_provider = "openai"/);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")).auth_mode, "chatgpt");
  assert.equal(await exists(backupDir), true);
});

test("profile file API rejects unknown and unsafe profile ids", async () => {
  const home = await makeConfigHome();
  await assert.rejects(
    invokeAction("profile:file:get", { codexHome: home, profileId: "../nope", file: "config" }),
    /Invalid profile id/
  );
  await assert.rejects(
    invokeAction("profile:file:get", { codexHome: home, profileId: "missing", file: "config" }),
    /Profile not found/
  );
});

test("profile file API rejects invalid third-party provider configs", async () => {
  const home = await makeConfigHome();
  const created = await invokeAction("provider:create", {
    codexHome: home,
    label: "Axis",
    configText: 'model_provider = "axis"\nmodel = "gpt-5.5"\n\n[model_providers.axis]\nname = "axis"\nbase_url = "https://api.axis.fan"\nwire_api = "responses"\n',
    authText: '{ "OPENAI_API_KEY": "sk-axis" }\n',
    switch: false
  });

  await assert.rejects(
    invokeAction("profile:file:write", {
      codexHome: home,
      profileId: created.profile.id,
      file: "config",
      content: 'model = "gpt-5.5"\n',
      confirmed: true
    }),
    /must set model_provider/
  );

  await fs.writeFile(path.join(home, "chat-manager-profiles", `${created.profile.id}.toml`), 'model = "gpt-5.5"\n');
  await assert.rejects(
    invokeAction("profile:switch", { codexHome: home, profileId: created.profile.id, confirmed: true }),
    /must set model_provider/
  );
});

test("app API and preload action whitelist reject unknown actions", async () => {
  await assert.rejects(invokeAction("bad:action", {}), /Unknown action/);
  const preload = await fs.readFile(path.join(root, "electron", "preload.cjs"), "utf8");
  assert.match(preload, /Unknown action/);
  assert.match(preload, /status:get/);
  assert.match(preload, /codex:processStatus/);
  assert.match(preload, /provider:officialFiles/);
});

test("Codex Desktop process actions are exposed", async () => {
  const status = await invokeAction("codex:processStatus", {});
  assert.equal(typeof status.running, "boolean");
  assert.ok(Array.isArray(status.processes));
});

test("renderer adapter supports Electron IPC and Web HTTP", async () => {
  const api = await fs.readFile(path.join(root, "renderer", "src", "api.js"), "utf8");
  assert.match(api, /window\.codexManager\?\.invoke/);
  assert.ok(api.includes('fetch("/api/action"'));
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
