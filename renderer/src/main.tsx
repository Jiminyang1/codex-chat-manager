import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ArchiveRestore,
  ChevronRight,
  Folder,
  KeyRound,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  Sun,
  Trash2
} from "lucide-react";
import { getCodexHome, invoke, setCodexHome } from "./api";
import { BackupDetail } from "./components/BackupDetail";
import { ConfirmModal, NewProviderModal, ProfileEditor } from "./components/Modals";
import { ProviderDetail } from "./components/ProviderDetail";
import { StatusPanel } from "./components/StatusPanel";
import { SyncDetail } from "./components/SyncDetail";
import { ThreadDetail } from "./components/ThreadDetail";
import logoUrl from "./assets/logo.svg";
import {
  backupBulkDeleteMessage,
  backupDeleteMessage,
  backupGroupMeta,
  backupProjectLabel,
  backupProjectPath,
  backupRestoreMessage,
  backupRowSubtitle,
  backupRowTitle,
  backupScopeLabel,
  backupSubtitle,
  backupTitle
} from "./lib/backup-helpers";
import { clamp, formatDate, projectName, shortPath, storedNumber } from "./lib/format";
import { alignProviderBlockWithModelProvider, defaultProviderAuth, defaultProviderConfig, officialSwitchMessage, profileSummary } from "./lib/provider-helpers";
import "./styles.css";
import type { BackupSummary, ConfigOverview, JsonRecord, ProcessStatus, Project, ProviderProfile, Status, SyncMode, Thread } from "../../src/types";
import type { ActionName } from "../../src/actions.cjs";

type ThemePreference = "system" | "light" | "dark";
type View = "chats" | "providers" | "sync" | "backups" | "settings";
type BackupCategory = "chats" | "providers" | "sync";
type ProviderItem = JsonRecord & {
  id: string;
  title: string;
  active?: boolean;
  current?: boolean;
  profile?: ProviderProfile;
  summary?: JsonRecord | null;
};
type SyncItem = {
  id: SyncMode;
  title: string;
  count: number;
  subtitle: string;
  description: string;
  actionLabel: string;
  tone: "primary" | "danger";
  groups: JsonRecord[];
};
type ModalState =
  | null
  | { kind: "new-provider" }
  | {
      kind?: undefined;
      title: string;
      body?: string;
      confirmLabel?: string;
      tone?: "primary" | "danger";
      hideCancel?: boolean;
      action: () => unknown | Promise<unknown>;
    };
type EditorState = {
  profile: ProviderProfile;
  tab: "config" | "auth";
  drafts: { config: string; auth: string };
} | null;
type NewProviderDraft = {
  label: string;
  configText: string;
  authText: string;
  switch: boolean;
};
type ProviderFilesState = JsonRecord & {
  key: string;
  loading: boolean;
  error: string;
  config: string;
  auth: string;
  missing: boolean;
};
type BackupGroup = {
  key: string;
  projectPath: string;
  title: string;
  backups: BackupSummary[];
  chatCount: number;
};
type ShellStyle = CSSProperties & {
  "--sidebar-width": string;
  "--detail-width": string;
};

const MUTATIONS_REQUIRING_CODEX_CLOSED = new Set<ActionName>([
  "thread:trash",
  "threads:trash",
  "project:delete",
  "backup:restore",
  "config:file:write",
  "config:fix",
  "config:sync",
  "profile:switch",
  "profile:delete",
  "profile:file:write",
  "provider:create",
  "provider:useOfficial"
]);

const BACKUP_CATEGORIES = [
  { id: "chats", title: "Chats / Projects", label: "Chats", icon: Folder },
  { id: "providers", title: "Config History", label: "Config", icon: KeyRound },
  { id: "sync", title: "Chat Sync History", label: "Chat Sync", icon: Shield }
 ] as const;

const THEME_STORAGE_KEY = "appearance.theme";
const THEME_OPTIONS = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon }
 ] as const;

let toastTimer: number | undefined;

function storedThemePreference(): ThemePreference {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_OPTIONS.some((option) => option.id === value) ? value as ThemePreference : "system";
}

function resolvedTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolvedTheme(preference);
  document.documentElement.dataset.themePreference = preference;
}

applyTheme(storedThemePreference());

function backupCategoryTitle(id: BackupCategory): string {
  return BACKUP_CATEGORIES.find((category) => category.id === id)?.title ?? "Backups";
}

function App() {
  const [codexHome, setHome] = useState(getCodexHome());
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projectlessThreads, setProjectlessThreads] = useState<Thread[]>([]);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [config, setConfig] = useState<ConfigOverview | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProjectlessThreadId, setSelectedProjectlessThreadId] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedSyncMode, setSelectedSyncMode] = useState<SyncMode>("repair");
  const [backupCategory, setBackupCategory] = useState<BackupCategory>("chats");
  const [selectedBackupPath, setSelectedBackupPath] = useState("");
  const [selectedBackupPaths, setSelectedBackupPaths] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<View>("chats");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningAction, setRunningAction] = useState<ActionName | "">("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [profileSummaries, setProfileSummaries] = useState<Record<string, JsonRecord | null>>({});
  const [providerFiles, setProviderFiles] = useState<ProviderFilesState>({ key: "", loading: false, error: "", config: "", auth: "", missing: false });
  const [expandedFiles, setExpandedFiles] = useState({ config: false, auth: false });
  const [selectedProviderCard, setSelectedProviderCard] = useState("official");
  const [editor, setEditor] = useState<EditorState>(null);
  const [newProvider, setNewProvider] = useState<NewProviderDraft>({
    label: "",
    configText: defaultProviderConfig("custom"),
    authText: defaultProviderAuth(),
    switch: true
  });
  const [expandedBackupGroups, setExpandedBackupGroups] = useState<Set<string>>(() => new Set());
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber("layout.sidebarWidth", 236));
  const [detailWidth, setDetailWidth] = useState(() => storedNumber("layout.detailWidth", 360));
  const [themePreference, setThemePreference] = useState(storedThemePreference);
  const runningActionRef = useRef<ActionName | "">("");

  const filteredProjectThreads = useMemo(() => {
    const text = search.trim().toLowerCase();
    return threads.filter((thread) => {
      if (!text) return true;
      return [thread.id, thread.title, thread.cwd, thread.model_provider, thread.preview]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(text));
    });
  }, [threads, search]);

  const filteredProjectlessThreads = useMemo(() => {
    const text = search.trim().toLowerCase();
    return projectlessThreads.filter((thread) => {
      if (!text) return true;
      return [thread.id, thread.title, thread.cwd, thread.model_provider, thread.preview]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(text));
    });
  }, [projectlessThreads, search]);

  const showingProjectlessChat = !selectedProject && Boolean(selectedProjectlessThreadId);
  const visibleThreads = showingProjectlessChat
    ? filteredProjectlessThreads.filter((thread) => thread.id === selectedProjectlessThreadId)
    : filteredProjectThreads;
  const selectedThread = visibleThreads.find((thread) => thread.id === selectedThreadId)
    ?? visibleThreads.find((thread) => thread.id === selectedProjectlessThreadId)
    ?? visibleThreads[0]
    ?? null;
  const selectedThreadList = visibleThreads.filter((thread) => selectedThreadIds.has(thread.id));
  const selectedThreadCount = selectedThreadList.length;
  const allVisibleThreadsSelected = visibleThreads.length > 0 && selectedThreadCount === visibleThreads.length;
  const activeProvider = config?.modelProvider ?? "";
  const retagCount = status && activeProvider && Number.isFinite(status.providerSyncMismatchCount)
    ? status.providerSyncMismatchCount
    : 0;
  const retagGroups = status?.providerSyncMismatchGroups ?? [];
  const repairCount = status && Number.isFinite(status.providerRepairMismatchCount) ? status.providerRepairMismatchCount : 0;
  const syncAttentionCount = repairCount + retagCount;
  const syncItems = useMemo<SyncItem[]>(() => [
    {
      id: "repair",
      title: "Conflicting provider tags",
      count: repairCount,
      subtitle: "Repair SQLite / rollout disagreements",
      description: "Fix provider tag conflicts without merging chats into another provider.",
      actionLabel: "Fix conflicts",
      tone: "primary",
      groups: status?.providerRepairMismatchGroups ?? []
    },
    {
      id: "retag",
      title: "Manual runtime retag",
      count: retagCount,
      subtitle: activeProvider ? `${retagCount} historical chat${retagCount === 1 ? "" : "s"} use another runtime tag` : "No current provider detected",
      description: activeProvider
        ? "Manual migration only. Retag only when these chats really belong to the current Codex runtime provider."
        : "Set a current provider before retagging chats.",
      actionLabel: "Retag runtime",
      tone: "danger",
      groups: retagGroups
    }
  ], [activeProvider, repairCount, retagCount, retagGroups, status]);
  const selectedSyncItem = syncItems.find((item) => item.id === selectedSyncMode) ?? syncItems[0];
  const providerItems = useMemo<ProviderItem[]>(() => {
    const savedProfiles = config?.profiles ?? [];
    const currentHostParts = String(config?.provider?.baseUrl ?? "").replace(/^https?:\/\//, "").split(/[/:]/)[0]?.split(".").filter(Boolean) ?? [];
    const currentTitle = currentHostParts.length > 1 ? currentHostParts.at(-2) : currentHostParts[0];
    const officialItem: ProviderItem = {
      id: "official",
      title: "OpenAI Official",
      badge: "official",
      active: config?.kind === "official" && activeProvider === "openai",
      summary: { provider: "openai", baseUrl: "built-in", model: config?.model ?? "-" }
    };
    const profileItems: ProviderItem[] = savedProfiles.map((profile) => ({
      id: profile.id,
      profile,
      title: profile.label,
      badge: profile.kind,
      active: profile.active,
      summary: profileSummaries[profile.id]
    }));
    const hasActiveSavedItem = officialItem.active || savedProfiles.some((profile) => profile.active);
    const currentItem = activeProvider && !hasActiveSavedItem
      ? [{
          id: "current-config",
          title: currentTitle || config?.provider?.name || activeProvider,
          badge: "not saved",
          active: true,
          current: true,
          summary: {
            provider: activeProvider,
            baseUrl: config?.provider?.baseUrl ?? (config?.kind === "official" ? "built-in" : "-"),
            model: config?.model ?? "-"
          }
        } satisfies ProviderItem]
      : [];
    return [...currentItem, officialItem, ...profileItems];
  }, [activeProvider, config, profileSummaries]);
  const profilesKey = (config?.profiles ?? []).map((profile) => `${profile.id}:${profile.updatedAt ?? profile.createdAt ?? ""}:${profile.active ? "1" : "0"}`).join("|");
  const selectedProviderItem = providerItems.find((item) => item.id === selectedProviderCard) ?? providerItems[0] ?? null;
  const activeProviderItem = providerItems.find((item) => item.active) ?? null;
  const backupCounts = useMemo<Record<BackupCategory, number>>(() => {
    const counts: Record<BackupCategory, number> = { chats: 0, providers: 0, sync: 0 };
    for (const backup of backups) {
      const category = backup.category === "chats" || backup.category === "providers" || backup.category === "sync" ? backup.category : "providers";
      counts[category] += 1;
    }
    return counts;
  }, [backups]);
  const filteredBackups = useMemo(() => (
    backups.filter((backup) => (backup.category ?? "providers") === backupCategory)
  ), [backups, backupCategory]);
  const groupedChatBackups = useMemo<BackupGroup[]>(() => {
    const groups: BackupGroup[] = [];
    const byProject = new Map<string, BackupGroup>();
    for (const backup of filteredBackups) {
      const projectPath = backupProjectPath(backup);
      const key = projectPath || "__projectless__";
      let group = byProject.get(key);
      if (!group) {
        group = {
          key,
          projectPath,
          title: backupProjectLabel(projectPath),
          backups: [],
          chatCount: 0
        };
        byProject.set(key, group);
        groups.push(group);
      }
      group.backups.push(backup);
      group.chatCount += backup.chatSummaries?.length || backup.threadIds?.length || 0;
    }
    return groups;
  }, [filteredBackups]);
  const selectedBackup = filteredBackups.find((backup) => backup.path === selectedBackupPath) ?? filteredBackups[0] ?? null;
  const selectedBackups = useMemo(() => backups.filter((backup) => selectedBackupPaths.has(backup.path)), [backups, selectedBackupPaths]);
  const selectedVisibleBackupCount = useMemo(() => filteredBackups.filter((backup) => selectedBackupPaths.has(backup.path)).length, [filteredBackups, selectedBackupPaths]);
  const allVisibleBackupsSelected = filteredBackups.length > 0 && selectedVisibleBackupCount === filteredBackups.length;

  function notify(message: string) {
    setToast(message);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(""), 3200);
  }

  function toggleBackupGroup(key: string) {
    setExpandedBackupGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleBackupSelection(backupPath: string, checked: boolean): void {
    setSelectedBackupPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(backupPath);
      else next.delete(backupPath);
      return next;
    });
  }

  function toggleVisibleBackupSelection(checked: boolean): void {
    setSelectedBackupPaths((current) => {
      const next = new Set(current);
      for (const backup of filteredBackups) {
        if (checked) next.add(backup.path);
        else next.delete(backup.path);
      }
      return next;
    });
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedThreadIds(new Set());
    setSelectedBackupPaths(new Set());
  }

  function toggleThreadSelection(threadId: string, checked: boolean): void {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (checked) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }

  function toggleVisibleThreadSelection(checked: boolean): void {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      for (const thread of visibleThreads) {
        if (checked) next.add(thread.id);
        else next.delete(thread.id);
      }
      return next;
    });
  }

  async function deleteSelectedThreads(): Promise<boolean> {
    const targets = visibleThreads.filter((thread) => selectedThreadIds.has(thread.id));
    if (!targets.length || runningActionRef.current) return false;
    runningActionRef.current = "threads:trash";
    setRunningAction("threads:trash");
    try {
      if (!(await ensureCodexClosed(deleteSelectedThreads))) return false;
      await invoke("threads:trash", { codexHome, threadIds: targets.map((thread) => thread.id), confirmed: true });
      const deletedCount = targets.length;
      setModal(null);
      setSelectedThreadIds(new Set());
      notify(`${deletedCount} chat${deletedCount === 1 ? "" : "s"} moved to backup`);
      await loadAll();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runningActionRef.current = "";
      setRunningAction("");
    }
  }

  async function deleteSelectedBackups(): Promise<boolean> {
    if (!selectedBackups.length || runningActionRef.current) return false;
    runningActionRef.current = "backup:delete";
    setRunningAction("backup:delete");
    try {
      for (const backup of selectedBackups) {
        await invoke("backup:delete", { codexHome, backupDir: backup.path, confirmed: true });
      }
      const deletedCount = selectedBackups.length;
      setModal(null);
      setSelectedBackupPaths(new Set());
      notify(`${deletedCount} backup${deletedCount === 1 ? "" : "s"} deleted`);
      await loadAll();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runningActionRef.current = "";
      setRunningAction("");
    }
  }

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    applyTheme(themePreference);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media || themePreference !== "system") return undefined;
    const syncSystemTheme = () => applyTheme("system");
    media.addEventListener?.("change", syncSystemTheme);
    return () => media.removeEventListener?.("change", syncSystemTheme);
  }, [themePreference]);

  async function loadAll() {
    setBusy(true);
    try {
      const nextConfig = await invoke("config:get", { codexHome });
      const resolvedHome = codexHome || nextConfig.codexHome;
      setCodexHome(resolvedHome);
      const [nextStatus, nextProjects, nextBackups] = await Promise.all([
        invoke("status:get", { codexHome: resolvedHome }),
        invoke("projects:list", { codexHome: resolvedHome }),
        invoke("backups:list", { codexHome: resolvedHome })
      ]);
      setStatus(nextStatus);
      setProjects(nextProjects);
      setBackups(nextBackups);
      setConfig(nextConfig);
      if (!codexHome && resolvedHome) {
        setHome(resolvedHome);
      }
      const [nextThreads, nextProjectlessThreads] = await Promise.all([
        invoke("threads:list", {
          codexHome: resolvedHome,
          project: selectedProject,
          provider: selectedProvider,
          archived
        }),
        invoke("threads:list", {
          codexHome: resolvedHome,
          ids: nextStatus.projectlessThreadIds ?? [],
          provider: selectedProvider,
          archived
        })
      ]);
      setThreads(nextThreads);
      setProjectlessThreads(nextProjectlessThreads);
      if (!selectedProject && !selectedProjectlessThreadId && nextProjectlessThreads[0]) {
        setSelectedProjectlessThreadId(nextProjectlessThreads[0].id);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadThreads() {
    try {
      const [nextThreads, nextProjectlessThreads] = await Promise.all([
        invoke("threads:list", {
          codexHome,
          project: selectedProject,
          provider: selectedProvider,
          archived
        }),
        invoke("threads:list", {
          codexHome,
          ids: status?.projectlessThreadIds ?? [],
          provider: selectedProvider,
          archived
        })
      ]);
      setThreads(nextThreads);
      setProjectlessThreads(nextProjectlessThreads);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRuntimeStatus() {
    if (runningActionRef.current) return;
    setBusy(true);
    try {
      const nextConfig = await invoke("config:get", { codexHome });
      const resolvedHome = codexHome || nextConfig.codexHome;
      setCodexHome(resolvedHome);
      const nextStatus = await invoke("status:get", { codexHome: resolvedHome });
      setConfig(nextConfig);
      setStatus(nextStatus);
      if (!codexHome && resolvedHome) setHome(resolvedHome);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadThreads();
    setSelectedThreadIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, selectedProvider, archived]);

  useEffect(() => {
    const validPaths = new Set(backups.map((backup) => backup.path));
    setSelectedBackupPaths((current) => {
      const next = new Set([...current].filter((backupPath) => validPaths.has(backupPath)));
      return next.size === current.size ? current : next;
    });
  }, [backups]);

  useEffect(() => {
    if (view === "sync") void refreshRuntimeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view !== "sync") return;
    if (selectedSyncMode === "repair" && repairCount === 0 && retagCount > 0) {
      setSelectedSyncMode("retag");
    } else if (selectedSyncMode === "retag" && retagCount === 0 && repairCount > 0) {
      setSelectedSyncMode("repair");
    }
  }, [repairCount, retagCount, selectedSyncMode, view]);

  useEffect(() => {
    async function loadProfileSummaries() {
      const summaries: Record<string, JsonRecord | null> = {};
      for (const profile of config?.profiles ?? []) {
        try {
          const file = await invoke("profile:file:get", { codexHome, profileId: profile.id, file: "config" });
          summaries[profile.id] = profileSummary(file.raw);
        } catch {
          summaries[profile.id] = null;
        }
      }
      setProfileSummaries(summaries);
    }
    loadProfileSummaries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexHome, profilesKey]);

  useEffect(() => {
    if (providerItems.length && !providerItems.some((item) => item.id === selectedProviderCard)) {
      setSelectedProviderCard(providerItems.find((item) => item.active)?.id ?? providerItems[0].id);
    }
  }, [providerItems, selectedProviderCard]);

  useEffect(() => {
    if (view === "backups" && selectedBackup?.path && selectedBackup.path !== selectedBackupPath) {
      setSelectedBackupPath(selectedBackup.path);
    }
  }, [selectedBackup, selectedBackupPath, view]);

  useEffect(() => {
    if (backupCategory !== "chats" || !selectedBackup) return;
    const selectedGroupKey = backupProjectPath(selectedBackup) || "__projectless__";
    setExpandedBackupGroups((current) => {
      if (current.has(selectedGroupKey)) return current;
      const next = new Set(current);
      next.add(selectedGroupKey);
      return next;
    });
  }, [backupCategory, selectedBackup]);

  useEffect(() => {
    let cancelled = false;
    async function loadProviderFiles() {
      if (view !== "providers" || !selectedProviderItem) return;
      const officialSnapshot = config?.officialAuthSnapshot;
      if (selectedProviderItem.current) {
        const key = `current:${config?.configPath ?? ""}:${config?.raw?.length ?? 0}:${config?.auth?.exists ? "auth" : "noauth"}`;
        setProviderFiles((previous) => ({ ...previous, key, loading: true, error: "", missing: false }));
        try {
          const authFile = await invoke("config:file:get", { codexHome, file: "auth" }).catch(() => ({ raw: "" }));
          if (!cancelled) {
            setProviderFiles({
              key,
              loading: false,
              error: "",
              config: config?.raw ?? "",
              auth: authFile.raw ?? "",
              missing: false,
              source: "current"
            });
          }
        } catch (error) {
          if (!cancelled) {
            setProviderFiles({ key, loading: false, error: error instanceof Error ? error.message : String(error), config: "", auth: "", missing: false });
          }
        }
        return;
      }
      if (selectedProviderItem.id === "official") {
        const key = `official:${officialSnapshot?.source ?? "missing"}:${officialSnapshot?.profileId ?? officialSnapshot?.backupDir ?? ""}`;
        setProviderFiles((previous) => ({ ...previous, key, loading: true, error: "", missing: false }));
        try {
          const officialFiles = await invoke("provider:officialFiles", { codexHome });
          if (!cancelled) {
            setProviderFiles({
              key,
              loading: false,
              error: "",
              config: officialFiles.config ?? "",
              auth: officialFiles.auth ?? "",
              missing: officialFiles.source === "missing",
              source: officialFiles.source,
              label: officialFiles.label ?? "",
              autoManaged: officialFiles.autoManaged === true,
              hasAuth: officialFiles.hasAuth === true,
              hasOfficialAuth: officialFiles.hasOfficialAuth === true,
              authSource: officialFiles.authSource ?? ""
            });
          }
        } catch (error) {
          if (!cancelled) {
            setProviderFiles({ key, loading: false, error: error instanceof Error ? error.message : String(error), config: "", auth: "", missing: false });
          }
        }
        return;
      }
      const profileId = selectedProviderItem.profile?.id;
      const key = `${selectedProviderItem.id}:${profileId ?? "missing"}`;
      if (!profileId) {
        setProviderFiles({ key, loading: false, error: "", config: "", auth: "", missing: true });
        return;
      }
      setProviderFiles((previous) => ({ ...previous, key, loading: true, error: "", missing: false }));
      try {
        const [configFile, authFile] = await Promise.all([
          invoke("profile:file:get", { codexHome, profileId, file: "config" }),
          invoke("profile:file:get", { codexHome, profileId, file: "auth" }).catch(() => ({ raw: "" }))
        ]);
        if (!cancelled) {
          setProviderFiles({
            key,
            loading: false,
            error: "",
            config: configFile.raw ?? "",
            auth: authFile.raw ?? "",
            missing: false
          });
        }
      } catch (error) {
        if (!cancelled) {
          setProviderFiles({ key, loading: false, error: error instanceof Error ? error.message : String(error), config: "", auth: "", missing: false });
        }
      }
    }
    loadProviderFiles();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    selectedProviderItem?.id,
    selectedProviderItem?.current,
    selectedProviderItem?.profile?.id,
    config?.configPath,
    config?.raw,
    config?.auth?.exists,
    config?.officialAuthSnapshot?.source,
    config?.officialAuthSnapshot?.profileId,
    config?.officialAuthSnapshot?.backupDir,
    config?.officialAuthSnapshot?.updatedAt,
    codexHome
  ]);

  async function runMutation(action: ActionName, payload: JsonRecord, success: string): Promise<boolean> {
    if (runningActionRef.current) return false;
    runningActionRef.current = action;
    setRunningAction(action);
    try {
      if (MUTATIONS_REQUIRING_CODEX_CLOSED.has(action) && !(await ensureCodexClosed(() => runMutation(action, payload, success)))) return false;
      const result = await invoke(action, { codexHome, ...payload, confirmed: true }) as JsonRecord;
      setModal(null);
      notify(result?.noOp ? "Already up to date" : success);
      await loadAll();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runningActionRef.current = "";
      setRunningAction("");
    }
  }

  async function ensureCodexClosed(onContinue: () => Promise<unknown> | unknown): Promise<boolean> {
    const processStatus = await invoke("codex:processStatus", { codexHome }) as ProcessStatus;
    if (!processStatus.running) return true;
    setModal({
      title: "Quit Codex Desktop?",
      body: [
        "Codex Desktop is currently running.",
        "",
        "This operation writes local Codex files or SQLite state. Close Codex first so it does not keep stale state in memory.",
        "",
        `Running process: ${processStatus.processes.map((proc) => proc.pid).join(", ")}`
      ].join("\n"),
      confirmLabel: "Quit and continue",
      tone: "primary",
      action: async () => {
        try {
          await invoke("codex:quit", { codexHome });
          await waitForCodexToQuit();
          setModal(null);
          await onContinue();
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error));
        }
      }
    });
    return false;
  }

  async function waitForCodexToQuit() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      const processStatus = await invoke("codex:processStatus", { codexHome }) as ProcessStatus;
      if (!processStatus.running) return;
    }
    throw new Error("Codex Desktop is still running. Quit it manually and try again.");
  }

  async function openProfileEditor(profile: ProviderProfile): Promise<void> {
    try {
      const [configFile, authFile] = await Promise.all([
        invoke("profile:file:get", { codexHome, profileId: profile.id, file: "config" }),
        invoke("profile:file:get", { codexHome, profileId: profile.id, file: "auth" }).catch(() => ({ raw: "" }))
      ]);
      setEditor({
        profile,
        tab: "config",
        drafts: { config: configFile.raw ?? "", auth: authFile.raw ?? "" }
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveEditor() {
    if (!editor) return;
    try {
      if (!(await ensureCodexClosed(saveEditor))) return;
      await invoke("profile:file:write", {
        codexHome,
        profileId: editor.profile.id,
        file: "config",
        content: editor.drafts.config,
        confirmed: true
      });
      await invoke("profile:file:write", {
        codexHome,
        profileId: editor.profile.id,
        file: "auth",
        content: editor.drafts.auth,
        confirmed: true
      });
      setEditor(null);
      notify("Profile saved");
      await loadAll();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function createNewProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const alignedConfigText = alignProviderBlockWithModelProvider(newProvider.configText);
      const providerPayload = {
        ...newProvider,
        label: newProvider.label.trim(),
        configText: alignedConfigText,
        authText: newProvider.authText
      };
      const didCreate = await runMutation("provider:create", providerPayload, "Provider created and active");
      if (!didCreate) return;
      setNewProvider({
        label: "",
        configText: defaultProviderConfig("custom"),
        authText: defaultProviderAuth(),
        switch: true
      });
      setModal(null);
      await loadAll();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function importCurrentProvider(): Promise<boolean> {
    if (runningActionRef.current) return false;
    runningActionRef.current = "profile:save";
    setRunningAction("profile:save");
    try {
      const result = await invoke("profile:save", {
        codexHome,
        label: "",
        note: "Imported from current Codex config.",
        kind: config?.kind || undefined
      });
      setSelectedProviderCard(result.profile.id);
      notify(`Imported ${result.profile.label}`);
      await loadAll();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runningActionRef.current = "";
      setRunningAction("");
    }
  }

  function selectView(nextView: View): void {
    setView(nextView);
    exitSelectMode();
    if (nextView !== "chats") {
      setSelectedProject("");
      setSelectedProjectlessThreadId("");
    }
    if (nextView !== "providers") setSelectedProvider("");
  }

  function startResize(which: "sidebar" | "detail", event: ReactMouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const startDetail = detailWidth;

    function onMove(moveEvent: MouseEvent): void {
      if (which === "sidebar") {
        const next = clamp(startSidebar + moveEvent.clientX - startX, 168, 360);
        setSidebarWidth(next);
        window.localStorage.setItem("layout.sidebarWidth", String(next));
      } else {
        const next = clamp(startDetail - (moveEvent.clientX - startX), 280, 560);
        setDetailWidth(next);
        window.localStorage.setItem("layout.detailWidth", String(next));
      }
    }

    function onUp(): void {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    }

    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="shell" style={{ "--sidebar-width": `${sidebarWidth}px`, "--detail-width": `${detailWidth}px` } as ShellStyle}>
      <aside className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt="" draggable={false} />
          <span>Codex Manager</span>
        </div>
        <button className={`nav ${view === "chats" ? "active" : ""}`} onClick={() => selectView("chats")} type="button">
          <Folder size={16} /> Chats
        </button>
        <button className={`nav ${view === "providers" ? "active" : ""}`} onClick={() => selectView("providers")} type="button">
          <KeyRound size={16} /> Providers
        </button>
        <button className={`nav ${view === "sync" ? "active" : ""}`} onClick={() => selectView("sync")} type="button">
          <Shield size={16} /> Sync Chat
        </button>
        <button className={`nav ${view === "backups" ? "active" : ""}`} onClick={() => selectView("backups")} type="button">
          <ArchiveRestore size={16} /> Backups
        </button>

        {view === "chats" && (
          <div className="side-section">
            <div className="side-title">Projects</div>
            {projects.map((project) => (
              <button className={`side-item ${selectedProject === project.path ? "selected" : ""}`} key={project.path} onClick={() => { setSelectedProject(project.path); setSelectedProjectlessThreadId(""); }} type="button">
                <span>{projectName(project.path)}</span><strong>{project.total}</strong>
              </button>
            ))}
            <div className="side-title side-title-spaced">Chats</div>
            {filteredProjectlessThreads.map((thread) => (
              <button className={`side-item ${selectedProjectlessThreadId === thread.id ? "selected" : ""}`} key={thread.id} onClick={() => { setSelectedProject(""); setSelectedProjectlessThreadId(thread.id); setSelectedThreadId(thread.id); }} type="button">
                <span>{thread.title || "(untitled)"}</span><strong>{formatDate(thread.updated_at).split(",").at(-1)?.trim() ?? ""}</strong>
              </button>
            ))}
          </div>
        )}

        {view === "backups" && (
          <div className="side-section">
            <div className="side-title">Backup domains</div>
            {BACKUP_CATEGORIES.map((category) => {
              const Icon = category.icon;
              return (
                <button className={`side-item side-item-icon ${backupCategory === category.id ? "selected" : ""}`} key={category.id} onClick={() => { setBackupCategory(category.id); setSelectedBackupPath(""); exitSelectMode(); }} type="button">
                  <span><Icon size={14} /> {category.label}</span><strong>{backupCounts[category.id] ?? 0}</strong>
                </button>
              );
            })}
          </div>
        )}

      </aside>
      <button className="resize-handle resize-sidebar" aria-label="Resize sidebar" onMouseDown={(event) => startResize("sidebar", event)} type="button" />

      <main className="content">
        <header className="toolbar">
          <div className="searchbox">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats, projects, providers" />
          </div>
          <button className="icon-button" onClick={loadAll} disabled={busy || Boolean(runningAction)} title="Refresh" type="button"><RefreshCw size={16} className={busy ? "spin" : ""} /></button>
          <button className="icon-button" onClick={() => selectView("settings")} title="Settings" type="button"><Settings size={16} /></button>
        </header>

        <section className="split">
          <div className="list-pane">
            {view === "chats" && (
              <>
                <div className="pane-head">
                  <div><h1>Chats</h1><p>{visibleThreads.length} shown · {status?.totals?.threads ?? 0} total · db {status?.integrity ?? "-"}</p></div>
                  <div className="pane-actions pane-tools">
                    <div className="segmented thread-state-control" role="group" aria-label="Chat state">
                      <button className={!archived ? "active" : ""} onClick={() => setArchived(false)} type="button">Active</button>
                      <button className={archived ? "active" : ""} onClick={() => setArchived(true)} type="button">Archived</button>
                    </div>
                    {visibleThreads.length > 0 && (
                      <button className={`select-toggle ${selectMode ? "on" : ""}`} onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)} type="button">{selectMode ? "Done" : "Select"}</button>
                    )}
                  </div>
                </div>
                {selectMode && visibleThreads.length > 0 && (
                  <div className={`select-bar ${selectedThreadCount ? "active" : ""}`}>
                    <label className="select-check">
                      <input
                        ref={(el) => { if (el) el.indeterminate = selectedThreadCount > 0 && !allVisibleThreadsSelected; }}
                        checked={allVisibleThreadsSelected}
                        onChange={(event) => toggleVisibleThreadSelection(event.currentTarget.checked)}
                        type="checkbox"
                      />
                      <span>{selectedThreadCount ? `${selectedThreadCount} selected` : "Select all"}</span>
                    </label>
                    {selectedThreadCount > 0 && (
                      <div className="select-bar-actions">
                        <button className="link-button" onClick={() => setSelectedThreadIds(new Set())} type="button">Clear</button>
                        <button className="danger ghost compact" disabled={Boolean(runningAction)} onClick={() => setModal({
                          title: "Delete selected chats",
                          body: [
                            `Move ${selectedThreadCount} selected chat${selectedThreadCount === 1 ? "" : "s"} to backup.`,
                            "",
                            "Each chat moves into a restorable backup. You can bring them back from Backups.",
                            "",
                            ...selectedThreadList.slice(0, 6).map((thread) => `- ${thread.title || "(untitled)"}`),
                            ...(selectedThreadCount > 6 ? [`- ${selectedThreadCount - 6} more`] : [])
                          ].join("\n"),
                          confirmLabel: `Delete ${selectedThreadCount}`,
                          tone: "danger",
                          action: deleteSelectedThreads
                        })} type="button"><Trash2 size={14} /> Delete {selectedThreadCount}</button>
                      </div>
                    )}
                  </div>
                )}
                <div className={`rows ${selectMode ? "selecting" : ""}`}>
                  {visibleThreads.map((thread) => (
                    <div className={`row select-row ${!selectMode && selectedThread?.id === thread.id ? "selected" : ""} ${selectMode && selectedThreadIds.has(thread.id) ? "checked" : ""}`} key={thread.id}>
                      <label className="check-cell" title="Select chat">
                        <input aria-label={`Select ${thread.title || "(untitled)"}`} checked={selectedThreadIds.has(thread.id)} onChange={(event) => toggleThreadSelection(thread.id, event.currentTarget.checked)} type="checkbox" />
                      </label>
                      <button className="row-content" onClick={() => selectMode ? toggleThreadSelection(thread.id, !selectedThreadIds.has(thread.id)) : setSelectedThreadId(thread.id)} type="button">
                        <div className="row-main">
                          <strong>{thread.title || "(untitled)"}</strong>
                          <span>{projectName(thread.cwd)} · {thread.model_provider} · {formatDate(thread.updated_at)}</span>
                        </div>
                        <div className="row-tail">
                          <ChevronRight size={15} />
                        </div>
                      </button>
                    </div>
                  ))}
                  {!visibleThreads.length && <div className="empty">No chats match the current filters.</div>}
                </div>
              </>
            )}

            {view === "providers" && (
              <>
                <div className="pane-head provider-pane-head">
                  <div>
                    <h1>Providers</h1>
                    <div className="provider-active">
                      <span>Active</span>
                      <strong>{activeProvider || "-"}</strong>
                      {activeProviderItem?.current && <em>detected, not saved</em>}
                    </div>
                  </div>
                  <button className="primary" onClick={() => {
                    setNewProvider({
                      label: "",
                      configText: defaultProviderConfig("custom"),
                      authText: defaultProviderAuth(),
                      switch: true
                    });
                    setModal({ kind: "new-provider" });
                  }} type="button"><Plus size={14} /> New</button>
                </div>
                <div className="rows">
                  {providerItems.map((item) => (
                    <button className={`row provider-row ${item.current ? "detected" : ""} ${selectedProviderCard === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedProviderCard(item.id)} type="button">
                      <div className="row-main">
                        <strong>{item.title}</strong>
                        <span>{item.summary?.provider ?? "-"} · {item.summary?.baseUrl ?? "-"} · {item.summary?.model ?? "-"}</span>
                      </div>
                      <div className="row-tail">
                        {item.current && <span className="badge warn">not saved</span>}
                        {item.active ? <span className="badge ok">active</span> : <ChevronRight size={15} />}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {view === "sync" && (
              <>
                <div className="pane-head">
                  <div>
                    <h1 className="title-line">Sync Chat <span className="badge beta">Beta</span></h1>
                    <p>{syncAttentionCount ? `${syncAttentionCount} runtime tag issue${syncAttentionCount === 1 ? "" : "s"} need attention` : "Runtime tags clean"} · active {activeProvider || "-"}</p>
                  </div>
                </div>
                <div className="rows">
                  {syncItems.map((item) => (
                    <button className={`row ${selectedSyncMode === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedSyncMode(item.id)} type="button">
                      <div className="row-main">
                        <strong>{item.title}</strong>
                        <span>{item.subtitle}</span>
                      </div>
                      <span className={`badge ${item.count ? "warn" : "ok"}`}>{item.count}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {view === "backups" && (
              <>
                <div className="pane-head">
                  <div>
                    <h1>{backupCategoryTitle(backupCategory)}</h1>
                    <p>{filteredBackups.length} of {backups.length} restorable snapshots</p>
                  </div>
                  {filteredBackups.length > 0 && (
                    <div className="pane-actions">
                      <button className={`select-toggle ${selectMode ? "on" : ""}`} onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)} type="button">{selectMode ? "Done" : "Select"}</button>
                    </div>
                  )}
                </div>
                {selectMode && filteredBackups.length > 0 && (
                  <div className={`select-bar ${selectedBackups.length ? "active" : ""}`}>
                    <label className="select-check">
                      <input
                        ref={(el) => { if (el) el.indeterminate = selectedVisibleBackupCount > 0 && !allVisibleBackupsSelected; }}
                        checked={allVisibleBackupsSelected}
                        onChange={(event) => toggleVisibleBackupSelection(event.currentTarget.checked)}
                        type="checkbox"
                      />
                      <span>{selectedBackups.length ? `${selectedBackups.length} selected` : "Select all"}</span>
                    </label>
                    {selectedBackups.length > 0 && (
                      <div className="select-bar-actions">
                        <button className="link-button" onClick={() => setSelectedBackupPaths(new Set())} type="button">Clear</button>
                        <button className="danger ghost compact" disabled={Boolean(runningAction)} onClick={() => setModal({
                          title: "Delete selected backups",
                          body: backupBulkDeleteMessage(selectedBackups),
                          confirmLabel: `Delete ${selectedBackups.length}`,
                          tone: "danger",
                          action: deleteSelectedBackups
                        })} type="button"><Trash2 size={14} /> Delete {selectedBackups.length}</button>
                      </div>
                    )}
                  </div>
                )}
                <div className={`rows ${selectMode ? "selecting" : ""}`}>
                  {backupCategory === "chats"
                    ? groupedChatBackups.map((group) => (
                      <div className="backup-group" key={group.key}>
                        <button aria-expanded={expandedBackupGroups.has(group.key)} className="backup-group-head" onClick={() => toggleBackupGroup(group.key)} type="button">
                          <ChevronRight className={`backup-group-chevron ${expandedBackupGroups.has(group.key) ? "expanded" : ""}`} size={14} />
                          <div>
                            <strong>{group.title}</strong>
                            <span>{backupGroupMeta(group)}</span>
                          </div>
                          <em title={`${group.backups.length} backup snapshot${group.backups.length === 1 ? "" : "s"}`}>{group.backups.length}</em>
                        </button>
                        {expandedBackupGroups.has(group.key) && group.backups.map((backup) => (
                          <div className={`row select-row backup-row-nested ${!selectMode && selectedBackup?.path === backup.path ? "selected" : ""} ${selectMode && selectedBackupPaths.has(backup.path) ? "checked" : ""}`} key={backup.path}>
                            <label className="check-cell" title="Select backup">
                              <input aria-label={`Select ${backupRowTitle(backup)}`} checked={selectedBackupPaths.has(backup.path)} onChange={(event) => toggleBackupSelection(backup.path, event.currentTarget.checked)} type="checkbox" />
                            </label>
                            <button className="row-content" onClick={() => selectMode ? toggleBackupSelection(backup.path, !selectedBackupPaths.has(backup.path)) : setSelectedBackupPath(backup.path)} type="button">
                              <div className="row-main">
                                <strong>{backupRowTitle(backup)}</strong>
                                <span>{backupRowSubtitle(backup)}</span>
                              </div>
                              <div className="row-tail">
                                <ChevronRight size={15} />
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    ))
                    : filteredBackups.map((backup) => (
                      <div className={`row select-row ${!selectMode && selectedBackup?.path === backup.path ? "selected" : ""} ${selectMode && selectedBackupPaths.has(backup.path) ? "checked" : ""}`} key={backup.path}>
                        <label className="check-cell" title="Select backup">
                          <input aria-label={`Select ${backupTitle(backup)}`} checked={selectedBackupPaths.has(backup.path)} onChange={(event) => toggleBackupSelection(backup.path, event.currentTarget.checked)} type="checkbox" />
                        </label>
                        <button className="row-content" onClick={() => selectMode ? toggleBackupSelection(backup.path, !selectedBackupPaths.has(backup.path)) : setSelectedBackupPath(backup.path)} type="button">
                          <div className="row-main">
                            <strong>{backupTitle(backup)}</strong>
                            <span>{backupSubtitle(backup)}</span>
                          </div>
                          <div className="row-tail">
                            <ChevronRight size={15} />
                          </div>
                        </button>
                      </div>
                    ))}
                  {!filteredBackups.length && <div className="empty">No {backupCategoryTitle(backupCategory).toLowerCase()} backups yet.</div>}
                </div>
              </>
            )}

            {view === "settings" && (
              <div className="settings-pane">
                <h1>Settings</h1>
                <section className="settings-section">
                  <h2>Appearance</h2>
                  <div className="segmented theme-control" role="group" aria-label="Appearance">
                    {THEME_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      return (
                        <button className={themePreference === option.id ? "active" : ""} key={option.id} onClick={() => setThemePreference(option.id)} type="button">
                          <Icon size={14} />
                          <span>{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="settings-section">
                  <h2>Data</h2>
                  <label className="field"><span>Codex home</span><input value={codexHome} onChange={(event) => setHome(event.target.value)} /></label>
                  <button className="primary" onClick={loadAll} type="button"><Save size={15} /> Save and reload</button>
                </section>
              </div>
            )}
          </div>
          <button className="resize-handle resize-detail" aria-label="Resize detail pane" onMouseDown={(event) => startResize("detail", event)} type="button" />

          <aside className="detail-pane">
            {view === "chats" && selectedThread && (
              <ThreadDetail thread={selectedThread} selectedProject={selectedProject} onDeleteThread={() => setModal({ title: "Delete chat", body: `${selectedThread.title || "(untitled)"}\n${shortPath(selectedThread.cwd)}`, confirmLabel: "Delete", tone: "danger", action: () => runMutation("thread:trash", { threadId: selectedThread.id }, "Chat moved to backup") })} onDeleteProject={() => selectedProject && setModal({ title: "Delete project", body: `${shortPath(selectedProject)}\nAll exact-cwd chats move into a restorable backup.`, confirmLabel: "Delete", tone: "danger", action: () => runMutation("project:delete", { project: selectedProject }, "Project deleted") })} />
            )}
            {view === "providers" && (
              <ProviderDetail item={selectedProviderItem} config={config} files={providerFiles} expandedFiles={expandedFiles} setExpandedFiles={setExpandedFiles} onUseOfficial={() => setModal({ title: "Switch to OpenAI Official", body: officialSwitchMessage(config?.officialAuthSnapshot), confirmLabel: "Switch", tone: "primary", action: () => runMutation("provider:useOfficial", {}, "Switched to OpenAI Official") })} onUseProfile={(profile) => setModal({ title: `Switch to ${profile.label}`, body: profile.hasAuth ? "This writes config.toml and auth.json from the profile snapshot." : "This writes config.toml. auth.json is unchanged.", confirmLabel: "Switch", tone: "primary", action: () => runMutation("profile:switch", { profileId: profile.id }, "Profile switched") })} onImportCurrent={importCurrentProvider} onEdit={openProfileEditor} onDelete={(profile) => setModal({ title: "Delete profile", body: [`Delete saved profile \"${profile.label}\"?`, "", `Provider id: ${profile.providerId || "unknown"}`, "Chats already tagged with this provider are not deleted.", "If this provider id still appears in chat history, Sync Chat can move chats to or away from it later. The saved config/auth snapshot will be removed."].join("\n"), confirmLabel: "Delete", tone: "danger", action: () => runMutation("profile:delete", { id: profile.id }, "Profile deleted") })} />
            )}
            {view === "sync" && (
              <SyncDetail
                item={selectedSyncItem}
                activeProvider={activeProvider}
                working={busy || runningAction === "config:sync"}
                onRun={(item) => setModal({
                  title: item.id === "repair" ? "Fix chat tag conflicts" : "Retag chat runtime provider",
                  body: item.id === "repair"
                    ? `Fix ${item.count} chat(s) where SQLite and rollout provider tags disagree. Each chat keeps its original provider.`
                    : [
                        `Retag ${item.count} historical chat(s) to the current Codex runtime provider: ${activeProvider || "-"}.`,
                        "",
                        `Current runtime groups: ${item.groups.map((group) => `${group.provider} (${group.count})`).join(", ") || "none"}.`,
                        "",
                        "Only retag when these chats should belong to the current runtime provider. Sync Chat creates a restorable backup first."
                      ].join("\n"),
                  confirmLabel: item.id === "repair" ? "Fix conflicts" : "Retag runtime",
                  tone: item.tone,
                  action: () => runMutation(
                    "config:sync",
                    { mode: item.id },
                    item.id === "repair" ? "Chat tag conflicts fixed" : "Chats retagged to current runtime provider"
                  )
                })}
              />
            )}
            {view === "backups" && (
              <BackupDetail
                backup={selectedBackup}
                activeProvider={activeProvider}
                onRestore={(scope) => selectedBackup && setModal({
                  title: backupScopeLabel(scope),
                  body: backupRestoreMessage(selectedBackup, scope, activeProvider),
                  confirmLabel: "Restore",
                  tone: scope === "metadata" ? "danger" : "primary",
                  action: () => runMutation("backup:restore", { backupDir: selectedBackup.path, scope }, "Backup restored")
                })}
                onDelete={() => selectedBackup && setModal({
                  title: "Delete backup",
                  body: backupDeleteMessage(selectedBackup),
                  confirmLabel: "Delete",
                  tone: "danger",
                  action: () => runMutation("backup:delete", { backupDir: selectedBackup.path }, "Backup deleted")
                })}
              />
            )}
            {view === "settings" && <StatusPanel status={status} />}
          </aside>
        </section>
      </main>

      {modal?.kind === "new-provider" && <NewProviderModal draft={newProvider} setDraft={setNewProvider} onCancel={() => setModal(null)} onSubmit={createNewProvider} />}
      {modal && modal.kind !== "new-provider" && <ConfirmModal modal={modal} onCancel={() => setModal(null)} />}
      {editor && <ProfileEditor editor={editor} setEditor={setEditor} onCancel={() => setEditor(null)} onSave={saveEditor} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
createRoot(rootElement).render(<App />);
