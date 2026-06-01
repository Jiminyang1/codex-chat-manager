import { z } from "zod";
import type {
  BackupScope,
  BackupSummary,
  ConfigFileName,
  ConfigOverview,
  JsonRecord,
  MutationResult,
  ProcessStatus,
  Project,
  ProviderProfile,
  Status,
  SyncMode,
  Thread
} from "./types.js";

const basePayload = z.object({
  codexHome: z.string().optional()
});

const mutationPayload = basePayload.extend({
  confirmed: z.boolean().optional()
});

const fileNameSchema = z.enum(["config", "auth"]);
const backupScopeSchema = z.enum(["chats", "config", "metadata"]);
const syncModeSchema = z.enum(["repair", "retag"]);

export const actionPayloadSchemas = {
  "status:get": basePayload,
  "projects:list": basePayload,
  "projectlessThreads:list": basePayload.extend({
    provider: z.string().optional(),
    archived: z.boolean().optional()
  }),
  "threads:list": basePayload.extend({
    ids: z.array(z.string()).optional(),
    project: z.string().optional(),
    provider: z.string().optional(),
    archived: z.boolean().optional()
  }),
  "backups:list": basePayload,
  "codex:processStatus": basePayload,
  "codex:quit": basePayload,
  "thread:trash": mutationPayload.extend({
    threadId: z.string().min(1, "threadId is required")
  }),
  "project:delete": mutationPayload.extend({
    project: z.string().min(1, "project is required")
  }),
  "backup:restore": mutationPayload.extend({
    backupDir: z.string().min(1, "backupDir is required"),
    scope: backupScopeSchema.optional()
  }),
  "config:get": basePayload,
  "config:file:get": basePayload.extend({
    file: fileNameSchema.optional()
  }),
  "config:file:write": mutationPayload.extend({
    file: fileNameSchema.optional(),
    content: z.string()
  }),
  "config:fix": mutationPayload.extend({
    to: z.string().optional()
  }),
  "config:sync": mutationPayload.extend({
    to: z.string().optional(),
    mode: syncModeSchema.optional()
  }),
  "profile:switch": mutationPayload.extend({
    profileId: z.string().min(1, "profileId is required")
  }),
  "profile:save": basePayload.extend({
    label: z.string().min(1, "label is required"),
    note: z.string().optional(),
    kind: z.string().optional()
  }),
  "profile:delete": mutationPayload.extend({
    id: z.string().min(1, "id is required")
  }),
  "profile:file:get": basePayload.extend({
    profileId: z.string().min(1, "profileId is required"),
    file: fileNameSchema.optional()
  }),
  "profile:file:write": mutationPayload.extend({
    profileId: z.string().min(1, "profileId is required"),
    file: fileNameSchema.optional(),
    content: z.string()
  }),
  "provider:create": basePayload.extend({
    label: z.string().min(1, "label is required"),
    configText: z.string().min(1, "configText is required"),
    authText: z.string().optional(),
    switch: z.boolean().optional()
  }),
  "provider:officialFiles": basePayload,
  "provider:useOfficial": mutationPayload
} as const;

export type ActionName = keyof typeof actionPayloadSchemas;
export type ActionPayloadMap = {
  [Action in ActionName]: z.infer<(typeof actionPayloadSchemas)[Action]>;
};
export type ActionPayload<Action extends ActionName> = ActionPayloadMap[Action];

export interface ActionResultMap {
  "status:get": Status;
  "projects:list": Project[];
  "projectlessThreads:list": Thread[];
  "threads:list": Thread[];
  "backups:list": BackupSummary[];
  "codex:processStatus": ProcessStatus;
  "codex:quit": { requested: boolean; reason?: string };
  "thread:trash": MutationResult;
  "project:delete": MutationResult;
  "backup:restore": MutationResult;
  "config:get": ConfigOverview;
  "config:file:get": { file: ConfigFileName; path: string; exists: boolean; raw: string };
  "config:file:write": MutationResult;
  "config:fix": MutationResult;
  "config:sync": MutationResult & { mode: SyncMode };
  "profile:switch": MutationResult;
  "profile:save": { saved: boolean; profile: ProviderProfile };
  "profile:delete": MutationResult;
  "profile:file:get": { profileId: string; file: ConfigFileName; path: string; exists: boolean; raw: string };
  "profile:file:write": MutationResult;
  "provider:create": { saved: boolean; profile: ProviderProfile; switched: boolean };
  "provider:officialFiles": JsonRecord;
  "provider:useOfficial": MutationResult;
}
export type ActionResult<Action extends ActionName> = ActionResultMap[Action];

export const allowedActionNames = Object.keys(actionPayloadSchemas) as ActionName[];

function formatPayloadError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "payload";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

export function parseActionPayload<Action extends ActionName>(
  action: Action,
  payload: unknown
): ActionPayload<Action> {
  const schema = actionPayloadSchemas[action];
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid payload for ${action}: ${formatPayloadError(parsed.error)}`);
  }
  return parsed.data as ActionPayload<Action>;
}

