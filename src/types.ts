export type JsonRecord = Record<string, any>;

export type ConfigFileName = "config" | "auth";
export type BackupScope = "chats" | "config" | "metadata";
export type ProviderKind = "official" | "third-party" | "unknown" | "custom" | string;
export type SyncMode = "repair" | "retag";

export interface Thread {
  id: string;
  rollout_path?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  source?: string | null;
  thread_source?: string | null;
  model_provider: string;
  cwd: string;
  title?: string | null;
  archived?: number | boolean | null;
  archived_at?: number | null;
  has_user_event?: number | boolean | null;
  first_user_message?: string | null;
  preview?: string | null;
  [key: string]: any;
}

export interface Project {
  path: string;
  saved: boolean;
  total: number;
  active: number;
  archived: number;
  interactive: number;
  updated_at: number | null;
}

export interface ProviderBlock {
  key: string;
  name: string | null;
  baseUrl: string | null;
  wireApi: string | null;
  requiresOpenaiAuth: boolean | string | number | null;
  envKey: string | null;
}

export interface ConfigSummary {
  model: string | number | boolean | null;
  modelProvider: string | null;
  configuredModelProvider: string | null;
  provider: ProviderBlock | null;
  bearer: {
    present: boolean;
    masked: string;
    value: string;
  };
}

export interface AuthSummary {
  exists: boolean;
  mode: string | null;
  hasApiKey: boolean;
  apiKey: string | null;
}

export interface ProviderProfile {
  id: string;
  label: string;
  note?: string;
  kind: ProviderKind;
  providerId?: string | null;
  hasAuth?: boolean;
  active?: boolean;
  missing?: boolean;
  autoDetected?: boolean;
  autoManaged?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: any;
}

export interface ConfigOverview extends ConfigSummary {
  codexHome: string;
  configPath: string;
  exists: boolean;
  raw: string;
  kind: ProviderKind;
  reservedBlocks: string[];
  auth: AuthSummary;
  officialAuthSnapshot: JsonRecord;
  autoOfficialSnapshot: JsonRecord;
  autoThirdPartyProfile: JsonRecord;
  profiles: ProviderProfile[];
}

export interface BackupFiles {
  db: boolean;
  config: boolean;
  auth: boolean;
  globalState: boolean;
  trashManifest: boolean;
  mutable: boolean;
}

export interface BackupSummary {
  name: string;
  path: string;
  createdAt: string;
  reason: string;
  category: string;
  kind: string;
  title: string;
  subject: string;
  projectRoot: string;
  scopes: BackupScope[];
  files: BackupFiles;
  threadIds: string[];
  chatSummaries: Thread[];
  copiedRollouts: JsonRecord[];
  codexHome: string;
  [key: string]: any;
}

export interface Status {
  codexHome: string;
  integrity: string;
  totals: JsonRecord;
  sqliteProviders: JsonRecord[];
  rolloutFiles: number;
  projectlessCount: number;
  projectlessThreadIds: string[];
  rolloutProviders: Record<string, number>;
  missingRolloutCount: number;
  missingDbCount: number;
  rolloutPathOutsideHomeCount: number;
  activeProvider: string | null;
  providerSyncMismatchCount: number;
  providerSyncMismatchGroups: JsonRecord[];
  providerRepairMismatchCount: number;
  providerRepairMismatchGroups: JsonRecord[];
  missingRollout: Thread[];
  missingDb: JsonRecord[];
  rolloutPathOutsideHome: Thread[];
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface ProcessStatus {
  running: boolean;
  processes: ProcessInfo[];
}

export interface MutationResult {
  dryRun: boolean;
  backupDir?: string | null;
  noOp?: boolean;
  [key: string]: any;
}

