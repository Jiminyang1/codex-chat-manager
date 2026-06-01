# Codex Chat Manager

![Codex Chat Manager logo](renderer/src/assets/logo.svg)

A local-first workbench for Codex Desktop chat history, provider profiles, backups, and safe recovery workflows.

Codex Chat Manager reads the same local files that Codex Desktop uses, then gives you a denser app UI and CLI for the work that is otherwise hard to inspect: which projects exist, which chats are attached to each provider, what can be restored, and whether chats are hidden because their provider tags no longer match the current provider.

## What It Does

- Browse Codex Desktop chats by project, provider, archived state, and projectless status.
- Manage provider profiles for `config.toml` and optional `auth.json` snapshots.
- Switch between saved providers, including OpenAI Official recovery from saved snapshots or backups.
- Safely trash chats, projects, or provider-specific chat sets with restorable backups.
- Restore chats, config/auth files, or provider metadata from backup snapshots.
- Sync chats to the current provider when old provider tags make them disappear from the active Codex view.
- Repair SQLite / rollout provider tag conflicts without merging chats into another provider.

## Safety Model

This tool only manages local Codex Desktop files. It does not touch remote ChatGPT account state, server-side conversations, or encrypted payload contents.

Mutations are designed to be reversible:

- CLI mutations are dry-run by default; pass `--yes` to execute.
- The app asks for confirmation before dangerous actions.
- A backup is created before each mutation under:

  ```text
  ~/.codex/backups_state/chat-manager/<timestamp>
  ```

- Rollout file edits preserve original file modification times, so retagging chats does not make every chat look newly updated in Codex Desktop.
- The tool refuses to mutate a thread whose `threads.rollout_path` points outside the selected `--codex-home`.
- App mutations check that Codex Desktop is closed before writing local state, so Desktop does not keep stale data in memory.

## Sync Chat Beta

`Sync Chat` is intentionally narrow in the app UI.

The main flow is:

1. Show the current active provider.
2. Show chats whose provider tag is outside that current provider.
3. Sync those chats into the current provider so Codex Desktop can see them in the active provider view.

The secondary repair flow fixes conflicts where SQLite and the rollout JSONL disagree about a chat provider. Repair keeps each chat on its original provider instead of merging it into the current provider.

The lower-level CLI/API still supports `config-sync --to <provider-id>` for recovery cases, such as moving chats back to a provider id after its saved profile was deleted. That escape hatch is deliberately not the default app workflow.

## Install

Requires Node.js `>=24`.

From GitHub:

```bash
npm install -g github:Jiminyang1/codex-chat-manager
codex-chat-manager status
codex-chat-manager web
```

From a local checkout:

```bash
npm install
npm run build
npm test
```

Run the desktop app in development:

```bash
npm run electron:dev
```

Run the browser workbench:

```bash
npm run web
```

Then open:

```text
http://127.0.0.1:8765
```

Install from a local package tarball:

```bash
npm pack --pack-destination dist
npm install -g ./dist/codex-chat-manager-*.tgz
```

## CLI Quick Reference

```bash
codex-chat-manager status
codex-chat-manager projects
codex-chat-manager chats --limit 20
codex-chat-manager chats --project /Users/me/project --limit 20
codex-chat-manager chats --provider openai --all
codex-chat-manager backups
```

Safe deletion and restore:

```bash
codex-chat-manager delete-chat <chat-id-or-prefix>
codex-chat-manager delete-chat <chat-id-or-prefix> --yes

codex-chat-manager delete-project '#3'
codex-chat-manager delete-project '#3' --yes

codex-chat-manager delete-provider <provider-id>
codex-chat-manager delete-provider <provider-id> --yes

codex-chat-manager restore '#1'
codex-chat-manager restore '#1' --scope chats --yes
codex-chat-manager restore '#1' --scope config --yes
codex-chat-manager restore '#1' --scope metadata --yes
```

Provider and config workflows:

```bash
codex-chat-manager config
codex-chat-manager config-save-profile "Axis"
codex-chat-manager profile-switch <profile-id>
codex-chat-manager config-delete-profile <profile-id> --yes

codex-chat-manager config-sync
codex-chat-manager config-sync --mode repair
codex-chat-manager config-sync --to <provider-id> --yes

codex-chat-manager config-fix --to openai-custom --yes
```

Useful global options:

```bash
--codex-home PATH   Use another Codex home instead of ~/.codex
--json              Print machine-readable JSON
--yes               Execute a mutation
--no-color          Disable ANSI color
```

## Storage Model

Codex Desktop stores chat state across multiple local layers:

- Rollout JSONL files in `~/.codex/sessions` and `~/.codex/archived_sessions`.
- SQLite thread index at `~/.codex/state_5.sqlite`.
- Desktop global state at `~/.codex/.codex-global-state.json`.
- Provider config and auth files at `~/.codex/config.toml` and `~/.codex/auth.json`.

Important behavior:

- Projects are path-based views derived from `threads.cwd` plus saved roots in global state.
- `model_provider` is a visibility namespace. A chat can exist locally but disappear from the current provider view when provider metadata is stale or mismatched.
- Projectless chats are regular threads with extra IDs and output-directory hints in global state.

More detail lives in [docs/storage-model.md](docs/storage-model.md).

## Architecture

This branch moves the project to a stricter app-oriented architecture:

- Node, Electron, tests, and renderer are TypeScript.
- Zod validates every public action payload at the app boundary.
- The renderer calls a typed `invoke(action, payload)` API shared with Electron preload and the local web server.
- Vite builds the React workbench into `dist/renderer`.
- Node/Electron/CLI code compiles into `dist/node`.
- Tailwind v4 is available through the Vite plugin, while the current workbench keeps a compact custom CSS surface.

Useful commands:

```bash
npm run build:node
npm run typecheck:renderer
npm run build
npm test
npm run pack:check
```

## Limits

- This is not a cloud sync tool.
- It cannot decrypt or re-encrypt `encrypted_content`.
- It cannot make provider/account-specific encrypted conversations portable.
- It does not hard-delete by default; deletion-style actions move data into restorable backups.
- Sync Chat is beta because provider metadata is a sharp edge in Codex Desktop local state.

## Release

`v0.1.0` already exists. The TypeScript + app workbench refactor should be released as a new version after the PR is merged to `main`, likely `v0.2.0`.

Suggested release flow:

```bash
git checkout main
git pull
npm version minor
npm run build
npm test
npm run pack:check
git push origin main --tags
```

For GitHub Releases, create a release from the new tag and attach the generated tarball if you want a downloadable package artifact.

For npm:

```bash
npm publish
```
