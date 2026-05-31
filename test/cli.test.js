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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
