# codex-chat-manager

Small local CLI and Web UI for inspecting and safely managing Codex Desktop chat history.

## Install

From GitHub:

```bash
npm install -g github:<owner>/codex-chat-manager
codex-chat-manager status
codex-chat-manager web
```

From npm, if published there:

```bash
npm install -g codex-chat-manager
codex-chat-manager status
codex-chat-manager web
```

From a local checkout:

```bash
npm install
npm test
npm run electron:dev
```

This tool understands the current Codex storage model:

- Rollout JSONL files under `~/.codex/sessions` and `~/.codex/archived_sessions` are the conversation source of truth.
- `~/.codex/state_5.sqlite` indexes chats in the `threads` table.
- Projects are path-based views derived from `threads.cwd` plus saved roots in `~/.codex/.codex-global-state.json`.
- `model_provider` is a visibility boundary. A chat can exist but disappear from the current provider view if rollout and SQLite metadata disagree.
- Projectless chats are tracked through `projectless-thread-ids`, workspace hints, and output-directory maps in `.codex-global-state.json`.

## Safety Model

Mutation commands are dry-run by default. Add `--yes` to execute.

Before any mutation, the tool creates a backup under:

```text
~/.codex/backups_state/chat-manager/<timestamp>
```

Trash-style deletion moves rollout files into the backup directory and removes their SQLite rows. It also removes thread references from global state. Hard delete is intentionally not implemented in this MVP.

Close Codex Desktop before running mutation commands for the cleanest result. If it is open, the SQLite write may still succeed, but the UI can keep stale in-memory data until restart.

The tool refuses to mutate a thread if `threads.rollout_path` points outside the selected `--codex-home`. This matters when testing against a copied SQLite database: Codex stores absolute rollout paths, so a fixture copy must rewrite those paths or the tool will stop instead of touching the real home.

## Desktop App

Development app:

```bash
npm run electron:dev
```

This starts the Vite renderer and opens the Electron app. The desktop app uses an IPC bridge, so it does not depend on the local web server.

Browser build:

```bash
npm run build:renderer
npm run web
```

Then open `http://127.0.0.1:8765`.

## Commands

Web UI, after building the renderer:

```bash
npm run build:renderer
npm run web
# or, after global install:
codex-chat-manager web
```

Then open:

```text
http://127.0.0.1:8765
```

CLI:

```bash
codex-chat-manager status
codex-chat-manager projects       # or: ps
codex-chat-manager chats --limit 20
codex-chat-manager chats --project /Users/me/project --limit 20
codex-chat-manager chats --provider openai --all
codex-chat-manager delete-chat <chat-id-prefix>
codex-chat-manager delete-chat <chat-id-prefix> --yes
codex-chat-manager delete-project '#3'
codex-chat-manager delete-project '#3' --yes
codex-chat-manager trash-provider <provider> --yes
codex-chat-manager backups
codex-chat-manager restore '#1' --yes
```

`delete-project` always removes the saved project root references and trashes every chat whose `cwd` exactly matches that project path.

CLI output is formatted for humans by default. Use `--json` for scripts. Project and backup tables include `#` references, so you can run commands like `delete-project '#3'` or `restore '#1'`. Chat tables show a short `Ref`; `delete-chat` accepts that short id if it uniquely identifies one chat.

## Important Limits

This is a local metadata/file manager. It does not manage ChatGPT account login, remote server state, or encrypted conversation payloads. If a rollout contains `encrypted_content` from another provider/account, this tool can hide or remove local records, but it cannot make that encrypted content portable.

## Release

Before publishing:

```bash
npm run build
npm test
npm run pack:check
```

For a GitHub release:

```bash
git tag v0.1.0
git push origin main --tags
```

For npm:

```bash
npm publish
```
