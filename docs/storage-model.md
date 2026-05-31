# Codex Storage Model

This document records the storage assumptions used by `codex-chat-manager`.

## Sources Of Truth

Codex Desktop keeps chat data in multiple local layers.

1. Rollout JSONL files

   ```text
   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
   ~/.codex/archived_sessions/rollout-*.jsonl
   ```

   The first line is usually a `session_meta` record. Important fields:

   - `payload.id`: thread id
   - `payload.cwd`: workspace/project path
   - `payload.model_provider`: provider visibility namespace
   - `payload.source` and `payload.thread_source`
   - `payload.git`, when available

2. SQLite index

   ```text
   ~/.codex/state_5.sqlite
   ```

   Main table: `threads`.

   Important columns:

   - `id`
   - `rollout_path`
   - `created_at`, `updated_at`, `created_at_ms`, `updated_at_ms`
   - `cwd`
   - `title`, `preview`, `first_user_message`
   - `model_provider`
   - `archived`, `archived_at`
   - `has_user_event`
   - `source`, `thread_source`

3. Desktop global state

   ```text
   ~/.codex/.codex-global-state.json
   ```

   Important keys:

   - `electron-saved-workspace-roots`
   - `project-order`
   - `active-workspace-roots`
   - `projectless-thread-ids`
   - `thread-workspace-root-hints`
   - `thread-projectless-output-directories`
   - `pinned-thread-ids`
   - nested `electron-persisted-atom-state` thread maps

## Project Semantics

There is no standalone `projects` table in `state_5.sqlite`.

A project is a path-based view:

```text
saved root from .codex-global-state.json
+ threads where threads.cwd equals that root
+ current provider / visibility filters
+ non-archived / interactive filters
```

Projectless chats are regular threads with extra IDs and output-directory hints in global state.

## Provider Semantics

`model_provider` is a visibility namespace. If rollout files and SQLite disagree, chats can exist but disappear from Desktop lists or `/resume`.

Known provider values can include case-sensitive variants such as:

```text
openai
OpenAI
ccswitch
```

Provider sync must update both rollout metadata and SQLite rows. This tool inspects provider state, but provider-wide metadata sync is intentionally left to `codex-provider-sync`.

## Delete Semantics

`codex-chat-manager` does not hard-delete by default.

Thread trashing does this:

1. Create a backup under `~/.codex/backups_state/chat-manager/<timestamp>`.
2. Copy `state_5.sqlite`, `.codex-global-state.json`, `config.toml`, and target rollout files into the backup.
3. Move target rollout files into `backup/trash/...`.
4. Delete rows from `threads`.
5. Clean known thread references from global state.
6. Clean dependent local tables:
   - `thread_dynamic_tools`
   - `thread_spawn_edges`
   - `agent_job_items.assigned_thread_id`

Project deletion removes saved project root references from global state and trashes all exact-`cwd` threads for that path.

## Safety Invariants

The tool must preserve these invariants:

- Never mutate a thread if `threads.rollout_path` is outside the selected `--codex-home`.
- Always dry-run mutation commands unless `--yes` is present.
- Always create a backup before mutation.
- Never edit ChatGPT account login, auth files, or remote account state.
- Never attempt to decrypt or re-encrypt `encrypted_content`.
- Prefer exact `cwd` matching for project deletion; do not delete nested paths unless a future command explicitly implements that behavior.
