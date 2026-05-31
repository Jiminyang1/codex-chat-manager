import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArchiveRestore,
  Check,
  ChevronRight,
  Folder,
  Info,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  Trash2
} from "lucide-react";
import { getCodexHome, invoke, setCodexHome } from "./api.js";
import "./styles.css";

function formatDate(seconds) {
  if (!seconds) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));
}

function shortPath(value) {
  return value ? String(value).replace(/^\/Users\/[^/]+/, "~") : "";
}

function projectName(value) {
  if (!value) return "(no project)";
  return String(value).split("/").filter(Boolean).at(-1) || shortPath(value);
}

function profileSummary(raw) {
  const provider = raw?.match(/^model_provider\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "") ?? "-";
  const baseUrl = raw?.match(/^base_url\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "") ?? "-";
  const modelLine = raw?.split("\n").find((line) => /^\s*model\s*=/.test(line) && !/model_provider/.test(line));
  return {
    provider,
    baseUrl,
    model: modelLine ? modelLine.split("=")[1].trim().replaceAll("\"", "") : "-"
  };
}

function providerIdFromConfig(raw) {
  return raw?.match(/^model_provider\s*=\s*"?(.+?)"?\s*$/m)?.[1]?.replaceAll("\"", "").trim() ?? "";
}

function officialSwitchMessage(snapshot) {
  if (snapshot?.source === "profile" && snapshot.hasOfficialAuth !== false) {
    const label = snapshot.autoManaged ? "the auto-saved OpenAI Official snapshot" : `"${snapshot.label}"`;
    return `Use ${label} and restore auth.json.`;
  }
  if (snapshot?.source === "backup") {
    if (snapshot.hasOfficialAuth) {
      return `Use backup config "${snapshot.label}" with current OpenAI login.`;
    }
    return `Backup "${snapshot.label}" has no usable auth.json.`;
  }
  return "Use OpenAI Official with current auth.json.";
}

function storedNumber(key, fallback) {
  const value = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const MUTATIONS_REQUIRING_CODEX_CLOSED = new Set([
  "thread:trash",
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

function App() {
  const [codexHome, setHome] = useState(getCodexHome());
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [projectlessThreads, setProjectlessThreads] = useState([]);
  const [backups, setBackups] = useState([]);
  const [config, setConfig] = useState(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProjectlessThreadId, setSelectedProjectlessThreadId] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [view, setView] = useState("chats");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState(null);
  const [profileSummaries, setProfileSummaries] = useState({});
  const [providerFiles, setProviderFiles] = useState({ key: "", loading: false, error: "", config: "", auth: "", missing: false });
  const [expandedFiles, setExpandedFiles] = useState({ config: false, auth: false });
  const [selectedProviderCard, setSelectedProviderCard] = useState("official");
  const [editor, setEditor] = useState(null);
  const [newProvider, setNewProvider] = useState({
    label: "",
    configText: "",
    authText: "",
    switch: true
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber("layout.sidebarWidth", 236));
  const [detailWidth, setDetailWidth] = useState(() => storedNumber("layout.detailWidth", 360));

  const providers = useMemo(() => {
    const counts = new Map();
    for (const row of status?.sqliteProviders ?? []) {
      counts.set(row.model_provider, (counts.get(row.model_provider) ?? 0) + Number(row.count || 0));
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [status]);

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
  const activeProvider = config?.modelProvider ?? "";
  const retagCount = status?.activeProvider === activeProvider && Number.isFinite(status?.providerSyncMismatchCount)
    ? status.providerSyncMismatchCount
    : providers.filter(([provider]) => provider !== activeProvider).reduce((sum, [, count]) => sum + count, 0);
  const repairCount = Number.isFinite(status?.providerRepairMismatchCount) ? status.providerRepairMismatchCount : 0;
  const providerItems = useMemo(() => [
    {
      id: "official",
      title: "OpenAI Official",
      badge: "official",
      active: config?.kind === "official" && activeProvider === "openai",
      summary: { provider: "openai", baseUrl: "built-in", model: config?.model ?? "-" }
    },
    ...(config?.profiles ?? []).map((profile) => ({
      id: profile.id,
      profile,
      title: profile.label,
      badge: profile.kind,
      active: profile.active,
      summary: profileSummaries[profile.id]
    }))
  ], [activeProvider, config, profileSummaries]);
  const profilesKey = (config?.profiles ?? []).map((profile) => `${profile.id}:${profile.updatedAt ?? profile.createdAt ?? ""}:${profile.active ? "1" : "0"}`).join("|");
  const selectedProviderItem = providerItems.find((item) => item.id === selectedProviderCard) ?? providerItems[0] ?? null;

  function notify(message) {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(""), 3200);
  }

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
      notify(error.message);
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
      notify(error.message);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, selectedProvider, archived]);

  useEffect(() => {
    async function loadProfileSummaries() {
      const summaries = {};
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
      setSelectedProviderCard(providerItems[0].id);
    }
  }, [providerItems, selectedProviderCard]);

  useEffect(() => {
    let cancelled = false;
    async function loadProviderFiles() {
      if (view !== "providers" || !selectedProviderItem) return;
      const officialSnapshot = config?.officialAuthSnapshot;
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
            setProviderFiles({ key, loading: false, error: error.message, config: "", auth: "", missing: false });
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
          setProviderFiles({ key, loading: false, error: error.message, config: "", auth: "", missing: false });
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
    selectedProviderItem?.profile?.id,
    config?.officialAuthSnapshot?.source,
    config?.officialAuthSnapshot?.profileId,
    config?.officialAuthSnapshot?.backupDir,
    config?.officialAuthSnapshot?.updatedAt,
    codexHome
  ]);

  async function runMutation(action, payload, success) {
    try {
      if (MUTATIONS_REQUIRING_CODEX_CLOSED.has(action) && !(await ensureCodexClosed(() => runMutation(action, payload, success)))) return false;
      await invoke(action, { codexHome, ...payload, confirmed: true });
      setModal(null);
      notify(success);
      await loadAll();
      return true;
    } catch (error) {
      notify(error.message);
      return false;
    }
  }

  async function ensureCodexClosed(onContinue) {
    const status = await invoke("codex:processStatus", { codexHome });
    if (!status.running) return true;
    setModal({
      title: "Quit Codex Desktop?",
      body: [
        "Codex Desktop is currently running.",
        "",
        "This operation writes local Codex files or SQLite state. Close Codex first so it does not keep stale state in memory.",
        "",
        `Running process: ${status.processes.map((proc) => proc.pid).join(", ")}`
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
          notify(error.message);
        }
      }
    });
    return false;
  }

  async function waitForCodexToQuit() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      const status = await invoke("codex:processStatus", { codexHome });
      if (!status.running) return;
    }
    throw new Error("Codex Desktop is still running. Quit it manually and try again.");
  }

  async function openProfileEditor(profile) {
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
      notify(error.message);
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
      if (editor.drafts.auth.trim()) {
        await invoke("profile:file:write", {
          codexHome,
          profileId: editor.profile.id,
          file: "auth",
          content: editor.drafts.auth,
          confirmed: true
        });
      }
      setEditor(null);
      notify("Profile saved");
      await loadAll();
    } catch (error) {
      notify(error.message);
    }
  }

  async function createNewProvider(event) {
    event.preventDefault();
    try {
      const providerPayload = {
        ...newProvider,
        configText: newProvider.configText || defaultProviderConfig(providerIdFromLabel(newProvider.label) || "custom"),
        authText: newProvider.authText || defaultProviderAuth()
      };
      const didCreate = await runMutation("provider:create", providerPayload, "Provider created and active");
      if (!didCreate) return;
      setNewProvider({
        label: "",
        configText: "",
        authText: "",
        switch: true
      });
      setModal(null);
      await loadAll();
    } catch (error) {
      notify(error.message);
    }
  }

  function selectView(nextView) {
    setView(nextView);
    if (nextView !== "chats") {
      setSelectedProject("");
      setSelectedProjectlessThreadId("");
    }
    if (nextView !== "providers") setSelectedProvider("");
  }

  function startResize(which, event) {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const startDetail = detailWidth;

    function onMove(moveEvent) {
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

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    }

    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="shell" style={{ "--sidebar-width": `${sidebarWidth}px`, "--detail-width": `${detailWidth}px` }}>
      <aside className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <span className="mark">◆</span>
          <span>Codex Manager</span>
        </div>
        <button className={`nav ${view === "chats" ? "active" : ""}`} onClick={() => selectView("chats")} type="button">
          <Folder size={16} /> Chats
        </button>
        <button className={`nav ${view === "providers" ? "active" : ""}`} onClick={() => selectView("providers")} type="button">
          <KeyRound size={16} /> Providers
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

      </aside>
      <button className="resize-handle resize-sidebar" aria-label="Resize sidebar" onMouseDown={(event) => startResize("sidebar", event)} type="button" />

      <main className="content">
        <header className="toolbar">
          <div className="searchbox">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats, projects, providers" />
          </div>
          <label className="toggle"><input checked={archived} onChange={(event) => setArchived(event.target.checked)} type="checkbox" /> Archived</label>
          <button className="icon-button" onClick={loadAll} title="Refresh" type="button"><RefreshCw size={16} className={busy ? "spin" : ""} /></button>
          <button className="icon-button" onClick={() => selectView("settings")} title="Settings" type="button"><Settings size={16} /></button>
        </header>

        <section className="split">
          <div className="list-pane">
            {view === "chats" && (
              <>
                <div className="pane-head">
                  <div><h1>Chats</h1><p>{visibleThreads.length} shown · {status?.totals?.threads ?? 0} total · db {status?.integrity ?? "-"}</p></div>
                </div>
                <div className="rows">
                  {visibleThreads.map((thread) => (
                    <button className={`row ${selectedThread?.id === thread.id ? "selected" : ""}`} key={thread.id} onClick={() => setSelectedThreadId(thread.id)} type="button">
                      <div className="row-main">
                        <strong>{thread.title || "(untitled)"}</strong>
                        <span>{projectName(thread.cwd)} · {thread.model_provider} · {formatDate(thread.updated_at)}</span>
                      </div>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                  {!visibleThreads.length && <div className="empty">No chats match the current filters.</div>}
                </div>
              </>
            )}

            {view === "providers" && (
              <>
                <div className="pane-head">
                  <div><h1>Providers</h1><p>Active: {activeProvider || "-"}</p></div>
                  <button className="primary compact" onClick={() => setModal({ kind: "new-provider" })} type="button"><Plus size={14} /> New</button>
                </div>
                <div className="rows">
                  {providerItems.map((item) => (
                    <button className={`row ${selectedProviderCard === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedProviderCard(item.id)} type="button">
                      <div className="row-main">
                        <strong>{item.title}</strong>
                        <span>{item.summary?.provider ?? "-"} · {item.summary?.baseUrl ?? "-"} · {item.summary?.model ?? "-"}</span>
                      </div>
                      {item.active ? <span className="badge ok">active</span> : <ChevronRight size={15} />}
                    </button>
                  ))}
                </div>
              </>
            )}

            {view === "backups" && (
              <>
                <div className="pane-head"><div><h1>Backups</h1><p>{backups.length} restorable snapshots</p></div></div>
                <div className="rows">
                  {backups.map((backup) => (
                    <button className="row" key={backup.path} onClick={() => setModal({ title: "Restore backup", body: `${backup.reason || "backup"}\n${new Date(backup.createdAt).toLocaleString()}`, confirmLabel: "Restore", tone: "danger", action: () => runMutation("backup:restore", { backupDir: backup.path }, "Backup restored") })} type="button">
                      <div className="row-main"><strong>{backup.reason || "backup"}</strong><span>{backup.threadIds.length} chats · {shortPath(backup.path)}</span></div>
                      <ArchiveRestore size={15} />
                    </button>
                  ))}
                  {!backups.length && <div className="empty">No backups yet.</div>}
                </div>
              </>
            )}

            {view === "settings" && (
              <div className="settings-pane">
                <h1>Settings</h1>
                <label className="field"><span>Codex home</span><input value={codexHome} onChange={(event) => setHome(event.target.value)} /></label>
                <button className="primary" onClick={loadAll} type="button"><Save size={15} /> Save and reload</button>
              </div>
            )}
          </div>
          <button className="resize-handle resize-detail" aria-label="Resize detail pane" onMouseDown={(event) => startResize("detail", event)} type="button" />

          <aside className="detail-pane">
            {view === "chats" && selectedThread && (
              <ThreadDetail thread={selectedThread} selectedProject={selectedProject} onDeleteThread={() => setModal({ title: "Delete chat", body: `${selectedThread.title || "(untitled)"}\n${shortPath(selectedThread.cwd)}`, confirmLabel: "Delete", tone: "danger", action: () => runMutation("thread:trash", { threadId: selectedThread.id }, "Chat moved to backup") })} onDeleteProject={() => selectedProject && setModal({ title: "Delete project", body: `${shortPath(selectedProject)}\nAll exact-cwd chats move into a restorable backup.`, confirmLabel: "Delete", tone: "danger", action: () => runMutation("project:delete", { project: selectedProject }, "Project deleted") })} />
            )}
            {view === "providers" && (
              <ProviderDetail item={selectedProviderItem} config={config} repairCount={repairCount} retagCount={retagCount} files={providerFiles} expandedFiles={expandedFiles} setExpandedFiles={setExpandedFiles} onUseOfficial={() => setModal({ title: "Switch to OpenAI Official", body: officialSwitchMessage(config?.officialAuthSnapshot), confirmLabel: "Switch", tone: "primary", action: () => runMutation("provider:useOfficial", {}, "Switched to OpenAI Official") })} onUseProfile={(profile) => setModal({ title: `Switch to ${profile.label}`, body: profile.hasAuth ? "This writes config.toml and auth.json from the profile snapshot." : "This writes config.toml. auth.json is unchanged.", confirmLabel: "Switch", tone: "primary", action: () => runMutation("profile:switch", { profileId: profile.id }, "Profile switched") })} onEdit={openProfileEditor} onDelete={(profile) => setModal({ title: "Delete profile", body: `Delete saved profile \"${profile.label}\"?`, confirmLabel: "Delete", tone: "danger", action: () => runMutation("profile:delete", { id: profile.id }, "Profile deleted") })} onExplainSync={() => setModal({ title: "Sync modes", body: ["Repair mismatches updates only chats where SQLite and rollout metadata disagree. It keeps each chat on its original provider tag.", "", "Retag all changes every chat outside the active provider to the current provider id. This makes hidden chats visible here, but overwrites previous provider tags.", "", "Both modes create a restorable backup first."].join("\n"), confirmLabel: "Close", tone: "primary", hideCancel: true, action: () => setModal(null) })} onRepair={() => setModal({ title: "Repair provider mismatches", body: `Repair ${repairCount} chat(s). This does not merge provider tags.`, confirmLabel: "Repair", tone: "primary", action: () => runMutation("config:sync", { mode: "repair" }, "Provider mismatches repaired") })} onRetag={() => setModal({ title: "Retag all chats", body: `Retag ${retagCount} chat(s) to ${activeProvider}. Previous provider tags will be overwritten.`, confirmLabel: "Retag", tone: "danger", action: () => runMutation("config:sync", { mode: "retag" }, "Chats retagged") })} />
            )}
            {view === "backups" && <div className="detail-empty"><ArchiveRestore size={28} /><p>Select a backup to restore it.</p></div>}
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

function ThreadDetail({ thread, selectedProject, onDeleteThread, onDeleteProject }) {
  const hasProject = Boolean(selectedProject);
  return (
    <div className="detail">
      <h2>{thread.title || "(untitled)"}</h2>
      <div className="kv"><span>ID</span><strong>{thread.id}</strong><span>Project</span><strong>{shortPath(thread.cwd)}</strong><span>Provider</span><strong>{thread.model_provider}</strong><span>Updated</span><strong>{formatDate(thread.updated_at)}</strong><span>Preview</span><strong>{thread.preview || thread.first_user_message || "-"}</strong></div>
      <div className="danger-zone">
        <button className="danger" onClick={onDeleteThread} type="button"><Trash2 size={15} /> Delete chat</button>
        <button className="danger ghost" onClick={onDeleteProject} disabled={!hasProject} type="button"><Trash2 size={15} /> Delete project</button>
      </div>
    </div>
  );
}

function ProviderDetail({
  item,
  config,
  repairCount,
  retagCount,
  files,
  expandedFiles,
  setExpandedFiles,
  onUseOfficial,
  onUseProfile,
  onEdit,
  onDelete,
  onExplainSync,
  onRepair,
  onRetag
}) {
  if (!item) {
    return <div className="detail-empty"><KeyRound size={28} /><p>Select a provider.</p></div>;
  }

  const isOfficial = item.id === "official";
  const profile = item.profile;
  const summary = item.summary ?? {};
  const officialSnapshot = config?.officialAuthSnapshot;
  const snapshotLabel = officialSnapshot?.available
    ? `${officialSnapshot.label}${officialSnapshot.autoManaged ? " (auto)" : ""}${officialSnapshot.source === "backup" ? " (backup config)" : ""}`
    : "not saved";
  return (
    <div className="detail">
      <div className="detail-title">
        <h2>{item.title}</h2>
        <span className="badge">{item.badge}</span>
        {item.active && <span className="badge ok"><Check size={12} /> active</span>}
      </div>
      <div className="kv">
        <span>Provider</span><strong>{summary.provider ?? "-"}</strong>
        <span>Base URL</span><strong>{summary.baseUrl ?? "-"}</strong>
        <span>Model</span><strong>{summary.model ?? config?.model ?? "-"}</strong>
        <span>Auth</span><strong>{isOfficial ? `OpenAI login (${config?.auth?.mode ?? "?"})` : profile?.hasAuth ? "profile auth snapshot" : "bearer token / unchanged auth"}</strong>
        {isOfficial && <><span>Snapshot</span><strong>{snapshotLabel}</strong></>}
        <span>Active config</span><strong>{config?.modelProvider ?? "-"}</strong>
        <span>Bearer</span><strong>{config?.bearer?.present ? config.bearer.masked : "none"}</strong>
      </div>
      <div className="actions">
        {isOfficial ? (
          <button className="primary" onClick={onUseOfficial} disabled={item.active} type="button">Use</button>
        ) : (
          <>
            <button className="primary" onClick={() => onUseProfile(profile)} disabled={item.active} type="button">Use</button>
            <button onClick={() => onEdit(profile)} type="button">Edit</button>
            <button className="danger-text" onClick={() => onDelete(profile)} type="button">Delete</button>
          </>
        )}
      </div>
      <ProviderFiles files={files} expandedFiles={expandedFiles} setExpandedFiles={setExpandedFiles} isOfficial={isOfficial} />
      <div className="sync-panel">
        <div className="sync-title">
          <span>Provider metadata</span>
          <button className="help-button" onClick={onExplainSync} title="Sync modes" type="button"><Info size={14} /></button>
        </div>
        <div className="sync-actions">
          <button onClick={onRepair} disabled={!repairCount} type="button"><Shield size={15} /> Repair mismatches</button>
          <button className="primary" onClick={onRetag} disabled={!retagCount} type="button"><Shield size={15} /> Retag all chats</button>
        </div>
      </div>
    </div>
  );
}

function ProviderFiles({ files, expandedFiles, setExpandedFiles, isOfficial }) {
  function toggle(file) {
    setExpandedFiles({ ...expandedFiles, [file]: !expandedFiles[file] });
  }

  if (files?.loading) {
    return <div className="file-panel"><div className="file-empty">Loading provider files...</div></div>;
  }
  if (files?.error) {
    return <div className="file-panel"><div className="file-empty">{files.error}</div></div>;
  }
  if (files?.missing) {
    return <div className="file-panel"><div className="file-empty">{isOfficial ? "No OpenAI Official config found in profiles or backups." : "No profile files found."}</div></div>;
  }

  return (
    <div className="file-panel">
      {isOfficial && files?.source === "backup" && (
        <div className="file-empty">
          Backup config: {files.label || "backup"}
          {files.authSource === "current" ? " · current auth.json" : files.hasAuth ? " · auth.json" : ""}
        </div>
      )}
      {isOfficial && files?.source === "profile" && (
        <div className="file-empty">Using {files.autoManaged ? "auto-saved" : "saved"} official profile snapshot: {files.label || "profile"}</div>
      )}
      <FileDisclosure title="config.toml" value={files?.config ?? ""} expanded={expandedFiles.config} onToggle={() => toggle("config")} />
      <FileDisclosure title="auth.json" value={files?.auth ?? ""} expanded={expandedFiles.auth} onToggle={() => toggle("auth")} />
    </div>
  );
}

function FileDisclosure({ title, value, expanded, onToggle }) {
  return (
    <section className="file-disclosure">
      <button className="file-toggle" onClick={onToggle} type="button">
        <ChevronRight className={expanded ? "expanded" : ""} size={14} />
        <span>{title}</span>
        <strong>{value ? `${value.length} bytes` : "empty"}</strong>
      </button>
      {expanded && <pre className="file-preview">{value || "(empty)"}</pre>}
    </section>
  );
}

function providerIdFromLabel(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function defaultProviderConfig(providerId) {
  const safeProviderId = providerId || "custom";
  return [
    `model_provider = "${safeProviderId}"`,
    'model = "gpt-5.5"',
    "",
    `[model_providers.${safeProviderId}]`,
    `name = "${safeProviderId}"`,
    'base_url = "https://api.example.com/v1"',
    'wire_api = "responses"',
    ""
  ].join("\n");
}

function updateProviderIdInDraftConfig(configText, previousId, nextId) {
  const oldId = previousId || "custom";
  const safeNextId = nextId || "custom";
  const oldConfig = defaultProviderConfig(oldId);
  if (!configText || configText === oldConfig) return defaultProviderConfig(safeNextId);
  return configText;
}

function defaultProviderAuth() {
  return `${JSON.stringify({ OPENAI_API_KEY: "" }, null, 2)}\n`;
}

function NewProviderModal({ draft, setDraft, onCancel, onSubmit }) {
  const defaultId = providerIdFromLabel(draft.label) || "custom";
  const configText = draft.configText || defaultProviderConfig(defaultId);
  const authText = draft.authText || defaultProviderAuth();
  const providerId = providerIdFromConfig(configText);

  function update(patch) {
    setDraft({ ...draft, ...patch });
  }

  function updateLabel(value) {
    const previousId = providerIdFromLabel(draft.label) || "custom";
    const nextProviderId = providerIdFromLabel(value) || "custom";
    update({
      label: value,
      configText: updateProviderIdInDraftConfig(draft.configText, previousId, nextProviderId)
    });
  }

  return (
    <div className="modal">
      <form className="modal-card provider-modal" onSubmit={onSubmit}>
        <div className="modal-title">
          <h2>New Codex provider</h2>
          <span className="badge">profile files</span>
        </div>
        <div className="provider-form-scroll">
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={draft.label} onChange={(event) => updateLabel(event.target.value)} placeholder="Axis" required />
            </label>
            <label className="field">
              <span>Provider ID</span>
              <input value={providerId} placeholder="from config.toml" readOnly />
            </label>
          </div>
          <label className="field">
            <span>config.toml</span>
            <textarea className="raw-editor" value={configText} onChange={(event) => update({ configText: event.target.value })} spellCheck="false" required />
          </label>
          <label className="field">
            <span>auth.json</span>
            <textarea className="raw-editor auth-editor" value={authText} onChange={(event) => update({ authText: event.target.value })} spellCheck="false" />
          </label>
          <div className="switch-row">
            <label><input checked={draft.switch} onChange={(event) => update({ switch: event.target.checked })} type="checkbox" /> use immediately</label>
          </div>
        </div>
        <div className="actions end">
          <button onClick={onCancel} type="button">Cancel</button>
          <button className="primary" type="submit"><Plus size={15} /> Create</button>
        </div>
      </form>
    </div>
  );
}

function StatusPanel({ status }) {
  return <div className="detail"><h2>Status</h2><div className="kv"><span>Codex home</span><strong>{status?.codexHome ?? "-"}</strong><span>SQLite</span><strong>{status?.integrity ?? "-"}</strong><span>Rollouts</span><strong>{status?.rolloutFiles ?? 0}</strong></div></div>;
}

function ConfirmModal({ modal, onCancel }) {
  const tone = modal.tone === "danger" ? "danger" : "primary";
  return (
    <div className="modal">
      <div className="modal-card">
        <h2>{modal.title}</h2>
        <pre>{modal.body}</pre>
        <div className="actions end">
          {!modal.hideCancel && <button onClick={onCancel} type="button">Cancel</button>}
          <button className={tone} onClick={modal.action} type="button">{modal.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

function ProfileEditor({ editor, setEditor, onCancel, onSave }) {
  const value = editor.drafts[editor.tab] ?? "";
  const providerId = providerIdFromConfig(editor.drafts.config);
  return (
    <div className="modal">
      <div className="modal-card editor">
        <h2>Edit {editor.profile.label}</h2>
        <div className="segmented"><button className={editor.tab === "config" ? "active" : ""} onClick={() => setEditor({ ...editor, tab: "config" })} type="button">config.toml</button><button className={editor.tab === "auth" ? "active" : ""} onClick={() => setEditor({ ...editor, tab: "auth" })} type="button">auth.json</button></div>
        {editor.tab === "config" && (
          <label className="field">
            <span>Provider ID</span>
            <input value={providerId} placeholder="from config.toml" readOnly />
          </label>
        )}
        <textarea value={value} onChange={(event) => setEditor({ ...editor, drafts: { ...editor.drafts, [editor.tab]: event.target.value } })} spellCheck="false" />
        <div className="actions end"><button onClick={onCancel} type="button">Cancel</button><button className="primary" onClick={onSave} type="button">Save</button></div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
