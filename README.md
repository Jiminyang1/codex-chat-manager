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
npm run web
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

## Commands

Web UI:

```bash
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
node src/cli.js status
node src/cli.js projects       # or: ps
node src/cli.js chats --limit 20
node src/cli.js chats --project /Users/me/project --limit 20
node src/cli.js chats --provider openai --all
node src/cli.js delete-chat <chat-id-prefix>
node src/cli.js delete-chat <chat-id-prefix> --yes
node src/cli.js delete-project '#3'
node src/cli.js delete-project '#3' --yes
node src/cli.js trash-provider <provider> --yes
node src/cli.js backups
node src/cli.js restore '#1' --yes
```

`delete-project` always removes the saved project root references and trashes every chat whose `cwd` exactly matches that project path.

CLI output is formatted for humans by default. Use `--json` for scripts. Project and backup tables include `#` references, so you can run commands like `delete-project '#3'` or `restore '#1'`. Chat tables show a short `Ref`; `delete-chat` accepts that short id if it uniquely identifies one chat.

## Important Limits

This is a local metadata/file manager. It does not manage ChatGPT account login, remote server state, or encrypted conversation payloads. If a rollout contains `encrypted_content` from another provider/account, this tool can hide or remove local records, but it cannot make that encrypted content portable.

## Release

Before publishing:

```bash
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
