import { COLOR, color } from "./format.js";

export type CliFlags = Record<string, string | boolean | undefined>;
export type ParsedArgs = {
  positionals: string[];
  flags: CliFlags;
};

function usage() {
  console.log(`${color(COLOR.bold, "codex-chat-manager")}

${color(COLOR.cyan, "Quick start")}
  codex-chat-manager status
  codex-chat-manager chats --limit 20
  codex-chat-manager projects
  codex-chat-manager backups
  codex-chat-manager web

${color(COLOR.cyan, "Delete, safely")}
  codex-chat-manager delete-chat <chat-id-or-prefix>
  codex-chat-manager delete-chat <chat-id-or-prefix> --yes
  codex-chat-manager delete-project '<path-or-#number>'
  codex-chat-manager delete-project '<path-or-#number>' --yes

${color(COLOR.cyan, "Commands")}
  status
  projects | ps
  list | chats | ls [--project PATH] [--provider ID] [--archived] [--all] [--limit N]
  delete-chat | trash-thread | rm-chat <chat-id-or-prefix>
  delete-project | rm-project '<path-or-#number>'
  trash-provider | delete-provider <provider-id>
  backups
  restore <backup-dir-or-#number> [--scope chats|config|metadata]
  web [--port 8765]

${color(COLOR.cyan, "Config / provider switching")}
  config | cfg
  profile-switch | switch <profile-id>
  config-save-profile <label> [--note TEXT]
  config-delete-profile <profile-id>
  config-sync | sync [--mode repair|retag] [--to <provider-id>]
                                 Repair SQLite/rollout mismatches or retag chats to the active provider
  config-fix | fix-reserved [--to <id>]     Rename a reserved [model_providers.openai] block to a custom id

${color(COLOR.cyan, "Options")}
  --codex-home PATH   Use another Codex home, default ~/.codex
  --json              Print machine-readable JSON
  --yes               Execute a mutation; without it, mutations are previews
  --no-color          Disable ANSI color
`);
}

function normalizeCommand(command: string | undefined): string | undefined {
  const aliases: Record<string, string> = {
    chat: "list",
    chats: "list",
    ls: "list",
    ps: "projects",
    backup: "backups",
    delete: "trash-thread",
    "delete-chat": "trash-thread",
    "rm-chat": "trash-thread",
    "rm-thread": "trash-thread",
    "delete-provider": "trash-provider",
    "rm-provider": "trash-provider",
    "rm-project": "delete-project",
    serve: "web",
    ui: "web",
    config: "config-show",
    cfg: "config-show",
    switch: "profile-switch",
    "save-profile": "config-save-profile",
    "delete-profile": "config-delete-profile",
    sync: "config-sync",
    "sync-provider": "config-sync",
    "fix-reserved": "config-fix",
    "fix-provider": "config-fix"
  };
  return command ? aliases[command] ?? command : command;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.split("=", 2);
    const name = rawName.slice(2);
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

export {
  normalizeCommand,
  parseArgs,
  usage
};
