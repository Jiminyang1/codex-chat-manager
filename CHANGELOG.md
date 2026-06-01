# Changelog

## Unreleased

- Migrate Node, Electron, tests, and renderer code to strict TypeScript.
- Rework the UI into a modern local workbench with React, Vite, and Tailwind v4 support.
- Add Zod action payload contracts shared by Electron, web, and renderer API calls.
- Add provider profile editing, OpenAI Official recovery, and safer provider switching flows.
- Simplify Sync Chat around syncing chats to the current provider, with a beta repair path for SQLite / rollout conflicts.
- Preserve rollout file modification times during provider retagging so chat history dates do not collapse to the sync time.
- Add in-flight guards for dangerous mutations and refresh actions.
- Add an app logo and prune unused code/styles.

## 0.1.0 - 2026-05-31

- Add CLI for inspecting Codex Desktop local chat storage.
- Add Web UI for browsing projects, providers, chats, and backups.
- Support safe chat deletion, project deletion, provider deletion, and restore.
- Back up SQLite state, global state, config, and rollout files before mutation.
- Support friendly CLI aliases, numbered project/backup references, and short chat id references.
- Document the Codex Desktop storage model used by the tool.
