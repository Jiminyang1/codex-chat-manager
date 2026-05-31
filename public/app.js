const state = {
  view: "chats",
  codexHome: "",
  status: null,
  projects: [],
  threads: [],
  backups: [],
  selectedProject: "",
  selectedProvider: "",
  config: null,
  rawFile: "config"
};

const $ = (id) => document.getElementById(id);

const els = {
  codexHomeInput: $("codexHomeInput"),
  codexHomeLabel: $("codexHomeLabel"),
  settingsBtn: $("settingsBtn"),
  settingsPop: $("settingsPop"),
  refreshButton: $("refreshButton"),
  searchInput: $("searchInput"),
  projectFilter: $("projectFilter"),
  providerFilter: $("providerFilter"),
  archivedOnly: $("archivedOnly"),
  metaLine: $("metaLine"),
  deleteProjectBtn: $("deleteProjectBtn"),
  backupsBtn: $("backupsBtn"),
  backupsPanel: $("backupsPanel"),
  threadList: $("threadList"),
  // config
  configKind: $("configKind"),
  configSummary: $("configSummary"),
  reservedBanner: $("reservedBanner"),
  syncHint: $("syncHint"),
  syncButton: $("syncButton"),
  presetCards: $("presetCards"),
  configForm: $("configForm"),
  fieldBaseUrl: $("fieldBaseUrl"),
  fieldWireApi: $("fieldWireApi"),
  fieldModel: $("fieldModel"),
  fieldRequiresAuth: $("fieldRequiresAuth"),
  fieldBearerValue: $("fieldBearerValue"),
  bearerReveal: $("bearerReveal"),
  saveProfileButton: $("saveProfileButton"),
  profileList: $("profileList"),
  rawDetails: $("rawDetails"),
  rawEditor: $("rawEditor"),
  rawPath: $("rawPath"),
  rawReload: $("rawReload"),
  rawSave: $("rawSave"),
  // shared
  modal: $("modal"),
  modalTitle: $("modalTitle"),
  modalBody: $("modalBody"),
  modalClose: $("modalClose"),
  modalCancel: $("modalCancel"),
  modalExecute: $("modalExecute"),
  toast: $("toast")
};

const tabs = Array.from(document.querySelectorAll(".tab"));

// --- helpers ---------------------------------------------------------------

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  const codexHome = state.codexHome || els.codexHomeInput.value;
  if (codexHome) url.searchParams.set("codexHome", codexHome);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

async function apiGet(path, params) {
  const response = await fetch(apiUrl(path, params));
  const payload = await response.json();
  if (!response.ok || payload?.error) throw new Error(payload.error || response.statusText);
  return payload;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ codexHome: state.codexHome || els.codexHomeInput.value, ...body })
  });
  const payload = await response.json();
  if (!response.ok || payload?.error) throw new Error(payload.error || response.statusText);
  return payload;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.add("hidden"), 3600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const escapeAttr = escapeHtml;

function formatDate(seconds) {
  if (!seconds) return "-";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(new Date(seconds * 1000));
}

function shortPath(value) {
  if (!value) return "";
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function projectName(value) {
  if (!value) return "(no project)";
  const parts = String(value).split("/").filter(Boolean);
  return parts[parts.length - 1] || shortPath(value);
}

function providerCounts() {
  const counts = new Map();
  for (const row of state.status?.sqliteProviders ?? []) {
    counts.set(row.model_provider, (counts.get(row.model_provider) ?? 0) + row.count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function currentThreads() {
  const search = els.searchInput.value.trim().toLowerCase();
  return state.threads.filter((thread) => {
    if (!search) return true;
    return [thread.id, thread.title, thread.cwd, thread.model_provider, thread.preview]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search));
  });
}

// --- modal -----------------------------------------------------------------

function openModal({ title, body, executeLabel = "Execute", onExecute }) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  els.modalExecute.textContent = executeLabel;
  els.modalExecute.onclick = async () => {
    try {
      await onExecute?.();
      closeModal();
      showToast("Done");
      await loadAll();
      if (state.view === "config") await loadConfig();
    } catch (error) {
      showToast(error.message);
    }
  };
  els.modal.classList.remove("hidden");
}

function closeModal() {
  els.modal.classList.add("hidden");
}

// --- chats view ------------------------------------------------------------

function renderFilters() {
  const projectOptions = [`<option value="">All projects (${state.projects.length})</option>`]
    .concat(state.projects.map((project) =>
      `<option value="${escapeAttr(project.path)}" ${project.path === state.selectedProject ? "selected" : ""}>${escapeHtml(projectName(project.path))} · ${project.total}</option>`));
  els.projectFilter.innerHTML = projectOptions.join("");

  const providerOptions = [`<option value="">All providers</option>`]
    .concat(providerCounts().map(([provider, count]) =>
      `<option value="${escapeAttr(provider)}" ${provider === state.selectedProvider ? "selected" : ""}>${escapeHtml(provider)} · ${count}</option>`));
  els.providerFilter.innerHTML = providerOptions.join("");

  els.deleteProjectBtn.classList.toggle("hidden", !state.selectedProject);
}

function renderMeta() {
  const status = state.status;
  const mismatch = (status?.missingRolloutCount ?? 0) + (status?.missingDbCount ?? 0) + (status?.rolloutPathOutsideHomeCount ?? 0);
  const parts = [`${currentThreads().length} shown`];
  if (status) {
    parts.push(`${status.totals?.threads ?? 0} total`);
    parts.push(`db ${status.integrity}`);
    if (mismatch) parts.push(`${mismatch} mismatches`);
  }
  els.metaLine.textContent = parts.join(" · ");
  els.codexHomeLabel.textContent = status?.codexHome ?? "";
}

function renderThreadList() {
  const threads = currentThreads();
  if (!threads.length) {
    els.threadList.innerHTML = `<div class="empty">No chats match your filters.</div>`;
    return;
  }
  els.threadList.innerHTML = threads.map((thread) => `
    <div class="chat-row">
      <div class="chat-main">
        <div class="chat-title">${escapeHtml(thread.title || "(untitled)")}</div>
        <div class="chat-sub">
          <span>${escapeHtml(projectName(thread.cwd))}</span>
          <span class="dot">·</span>
          <span class="tag">${escapeHtml(thread.model_provider)}</span>
          <span class="dot">·</span>
          <span>${escapeHtml(formatDate(thread.updated_at))}</span>
          ${thread.archived ? '<span class="dot">·</span><span class="tag muted">archived</span>' : ""}
        </div>
      </div>
      <button class="trash" data-trash="${escapeAttr(thread.id)}" type="button" title="Delete chat" aria-label="Delete chat">🗑</button>
    </div>
  `).join("");
}

function renderBackups() {
  if (!state.backups.length) {
    els.backupsPanel.innerHTML = `<div class="empty">No backups yet.</div>`;
    return;
  }
  els.backupsPanel.innerHTML = state.backups.map((backup) => `
    <div class="backup-row">
      <div>
        <div class="chat-title">${escapeHtml(backup.reason || "backup")}</div>
        <div class="chat-sub"><span>${escapeHtml(new Date(backup.createdAt).toLocaleString())}</span><span class="dot">·</span><span>${backup.threadIds.length} chats</span></div>
      </div>
      <button class="link" data-restore="${escapeAttr(backup.path)}" type="button">Restore</button>
    </div>
  `).join("");
}

function renderChats() {
  renderFilters();
  renderMeta();
  renderThreadList();
}

// --- config view -----------------------------------------------------------

function kindLabel(kind) {
  if (kind === "official") return "Official OpenAI";
  if (kind === "third-party") return "Third-party relay";
  return kind || "unknown";
}

function renderConfig() {
  const config = state.config;
  if (!config) return;
  els.configKind.textContent = kindLabel(config.kind);
  els.configKind.className = `badge ${config.kind === "official" ? "ok" : config.kind === "third-party" ? "warn" : ""}`;

  const reserved = config.reservedBlocks ?? [];
  if (reserved.length) {
    els.reservedBanner.classList.remove("hidden");
    els.reservedBanner.innerHTML = `
      <div>
        <strong>config.toml is invalid.</strong>
        <span>It defines <code>[model_providers.${escapeHtml(reserved[0])}]</code>, but <code>${escapeHtml(reserved[0])}</code> is a reserved built-in id Codex won't accept. Rename it to a custom id.</span>
      </div>
      <button id="fixReservedBtn" class="btn small danger" type="button">Fix (rename to openai-custom)</button>`;
  } else {
    els.reservedBanner.classList.add("hidden");
    els.reservedBanner.innerHTML = "";
  }

  const provider = config.provider ?? {};
  const rows = [
    ["Model", config.model ?? "-"],
    ["Provider id", config.modelProvider ?? "-"],
    ["Base URL", provider.baseUrl ?? "-"],
    ["Auth", provider.requiresOpenaiAuth ? `OpenAI login (${config.auth?.mode ?? "?"})` : "bearer token"],
    ["Bearer", config.bearer?.present ? config.bearer.masked : "none"]
  ];
  els.configSummary.innerHTML = rows.map(([label, value]) => `
    <div class="sum-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>
  `).join("");

  els.presetCards.innerHTML = (config.presets ?? []).map((preset) => {
    const active = preset.kind === config.kind;
    return `
      <div class="preset ${active ? "active" : ""}">
        <div class="preset-head">
          <h3>${escapeHtml(preset.label)}</h3>
          ${active ? '<span class="badge sm ok">active</span>' : ""}
        </div>
        <p class="muted-sm">${escapeHtml(preset.note)}</p>
        <button class="btn ${active ? "ghost" : "primary"} block" data-preset="${escapeAttr(preset.id)}" type="button" ${active ? "disabled" : ""}>
          ${active ? "Currently active" : "Switch to this"}
        </button>
      </div>
    `;
  }).join("");

  els.fieldBaseUrl.value = provider.baseUrl ?? "";
  els.fieldWireApi.value = provider.wireApi ?? "responses";
  els.fieldModel.value = config.model ?? "";
  els.fieldRequiresAuth.checked = provider.requiresOpenaiAuth === true;
  els.fieldBearerValue.value = config.bearer?.value ?? "";
  els.fieldBearerValue.type = "password";

  renderSyncHint();
  renderProfileList();
}

function renderSyncHint() {
  const active = state.config?.modelProvider;
  const mismatched = providerCounts().filter(([p]) => p !== active).reduce((sum, [, c]) => sum + c, 0);
  if (!active) {
    els.syncHint.textContent = "No active provider id set.";
    els.syncButton.disabled = true;
  } else if (mismatched > 0) {
    els.syncHint.innerHTML = `<span class="warn-text">${mismatched} chat(s) hidden under another provider.</span> Sync retags them to <code>${escapeHtml(active)}</code>.`;
    els.syncButton.disabled = false;
  } else {
    els.syncHint.textContent = "All chats match this provider.";
    els.syncButton.disabled = true;
  }
}

function renderProfileList() {
  const profiles = state.config?.profiles ?? [];
  if (!profiles.length) {
    els.profileList.innerHTML = `<div class="empty">No saved profiles.</div>`;
    return;
  }
  els.profileList.innerHTML = profiles.map((profile) => `
    <div class="profile ${profile.active ? "active" : ""}">
      <div>
        <div class="chat-title">${escapeHtml(profile.label)} ${profile.active ? '<span class="badge sm ok">active</span>' : ""}</div>
        <div class="chat-sub"><span>${escapeHtml(profile.kind)}</span>${profile.note ? `<span class="dot">·</span><span>${escapeHtml(profile.note)}</span>` : ""}</div>
      </div>
      <div class="profile-actions">
        <button class="link" data-apply-profile="${escapeAttr(profile.id)}" type="button" ${profile.missing ? "disabled" : ""}>Apply</button>
        <button class="link danger" data-delete-profile="${escapeAttr(profile.id)}" type="button">Delete</button>
      </div>
    </div>
  `).join("");
}

function changeSummaryText(result) {
  if (result.mode === "profile") {
    return `Replace config.toml with profile "${result.profile?.label ?? result.profile?.id}".\nBacked up first and restorable.`;
  }
  if (!result.changes?.length) return "No changes; config already matches.";
  const lines = result.changes.map((c) => `${c.scope}.${c.key}:  ${c.before === null ? "(unset)" : c.before}  →  ${c.after === null ? "(removed)" : c.after}`);
  return `${lines.join("\n")}\n\nBacked up first and restorable.`;
}

async function previewAndApply(payload, title) {
  try {
    const preview = await apiPost("/api/config/apply", payload);
    if (preview.mode === "fields" && !preview.changes?.length) {
      showToast("No changes; config already matches.");
      return;
    }
    openModal({
      title,
      body: changeSummaryText(preview),
      executeLabel: "Apply",
      onExecute: () => apiPost("/api/config/apply", { ...payload, confirmed: true })
    });
  } catch (error) {
    showToast(error.message);
  }
}

function applyFieldsFromForm() {
  const fields = {
    baseUrl: els.fieldBaseUrl.value.trim(),
    wireApi: els.fieldWireApi.value,
    model: els.fieldModel.value.trim(),
    requiresOpenaiAuth: els.fieldRequiresAuth.checked
  };
  const current = state.config?.bearer?.value ?? "";
  const next = els.fieldBearerValue.value.trim();
  if (next !== current) fields.bearer = next === "" ? "remove" : next;
  previewAndApply({ fields }, "Apply config changes");
}

// --- data loading ----------------------------------------------------------

async function loadThreads() {
  state.threads = await apiGet("/api/threads", {
    project: state.selectedProject,
    provider: state.selectedProvider,
    archived: els.archivedOnly.checked ? "1" : ""
  });
}

async function loadAll() {
  try {
    state.codexHome = els.codexHomeInput.value.trim() || state.codexHome;
    const [status, projects, backups] = await Promise.all([
      apiGet("/api/status"),
      apiGet("/api/projects"),
      apiGet("/api/backups")
    ]);
    state.status = status;
    state.projects = projects;
    state.backups = backups;
    if (!state.codexHome && status.codexHome) {
      state.codexHome = status.codexHome;
      els.codexHomeInput.value = status.codexHome;
    }
    if (state.selectedProject && !projects.some((p) => p.path === state.selectedProject)) state.selectedProject = "";
    await loadThreads();
    renderChats();
    renderBackups();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshThreads() {
  try {
    await loadThreads();
    renderChats();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadConfig() {
  try {
    state.config = await apiGet("/api/config");
    if (!state.codexHome && state.config.codexHome) {
      state.codexHome = state.config.codexHome;
      els.codexHomeInput.value = state.config.codexHome;
    }
    renderConfig();
  } catch (error) {
    showToast(error.message);
  }
}

function setView(view) {
  state.view = view;
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  $("view-chats").classList.toggle("hidden", view !== "chats");
  $("view-config").classList.toggle("hidden", view !== "config");
  if (view === "config" && !state.config) loadConfig();
}

// --- events ----------------------------------------------------------------

tabs.forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));

els.settingsBtn.addEventListener("click", () => els.settingsPop.classList.toggle("hidden"));
els.refreshButton.addEventListener("click", async () => {
  await loadAll();
  if (state.view === "config") await loadConfig();
});

els.searchInput.addEventListener("input", () => { renderMeta(); renderThreadList(); });
els.archivedOnly.addEventListener("change", refreshThreads);
els.projectFilter.addEventListener("change", () => {
  state.selectedProject = els.projectFilter.value;
  refreshThreads();
});
els.providerFilter.addEventListener("change", () => {
  state.selectedProvider = els.providerFilter.value;
  refreshThreads();
});

els.threadList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-trash]");
  if (!button) return;
  const thread = state.threads.find((t) => t.id === button.dataset.trash);
  if (!thread) return;
  openModal({
    title: "Delete chat",
    body: `"${thread.title || "(untitled)"}"\n${shortPath(thread.cwd)}\n\nThe chat and its rollout move into a restorable backup.`,
    executeLabel: "Delete",
    onExecute: () => apiPost("/api/trash-thread", { threadId: thread.id, confirmed: true })
  });
});

els.deleteProjectBtn.addEventListener("click", () => {
  const project = state.projects.find((p) => p.path === state.selectedProject);
  if (!project) return;
  openModal({
    title: "Delete project",
    body: `${shortPath(project.path)}\n${project.total} chats (${project.archived} archived)\n\nAll chats whose cwd matches this path move into a restorable backup.`,
    executeLabel: "Delete project",
    onExecute: () => apiPost("/api/delete-project", { project: project.path, confirmed: true })
  });
});

els.backupsBtn.addEventListener("click", () => {
  const hidden = els.backupsPanel.classList.toggle("hidden");
  els.backupsBtn.classList.toggle("active", !hidden);
});

els.backupsPanel.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore]");
  if (!button) return;
  const backup = state.backups.find((b) => b.path === button.dataset.restore);
  if (!backup) return;
  openModal({
    title: "Restore backup",
    body: `${backup.reason || "backup"}\n${new Date(backup.createdAt).toLocaleString()}\n\nThis restores the database and config from this backup (a pre-restore backup is taken first).`,
    executeLabel: "Restore",
    onExecute: () => apiPost("/api/restore", { backupDir: backup.path, confirmed: true })
  });
});

els.presetCards.addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  const preset = state.config?.presets?.find((p) => p.id === button.dataset.preset);
  previewAndApply({ preset: button.dataset.preset }, `Switch to ${preset ? preset.label : button.dataset.preset}`);
});

els.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFieldsFromForm();
});

els.bearerReveal.addEventListener("click", () => {
  els.fieldBearerValue.type = els.fieldBearerValue.type === "password" ? "text" : "password";
});

// Raw file editor (config.toml / auth.json)
async function loadRawFile(file) {
  try {
    const data = await apiGet("/api/config/file", { file });
    els.rawEditor.value = data.raw ?? "";
    els.rawPath.textContent = data.path + (data.exists ? "" : "  (missing)");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelectorAll(".raw-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.rawFile = tab.dataset.file;
    document.querySelectorAll(".raw-tab").forEach((t) => t.classList.toggle("active", t === tab));
    loadRawFile(state.rawFile);
  });
});

els.rawDetails.addEventListener("toggle", () => {
  if (els.rawDetails.open) loadRawFile(state.rawFile);
});

els.rawReload.addEventListener("click", () => loadRawFile(state.rawFile));

els.rawSave.addEventListener("click", () => {
  const file = state.rawFile;
  const content = els.rawEditor.value;
  const name = file === "auth" ? "auth.json" : "config.toml";
  openModal({
    title: `Save ${name}`,
    body: `Overwrite ${name} with the editor contents?\n\n${file === "auth" ? "It must be valid JSON. " : ""}A backup is taken first and is restorable.`,
    executeLabel: "Save",
    onExecute: async () => {
      const result = await apiPost("/api/config/file", { file, content, confirmed: true });
      await loadConfig();
      return result;
    }
  });
});

els.syncButton.addEventListener("click", async () => {
  try {
    const preview = await apiPost("/api/config/sync", {});
    if (preview.noOp || preview.total === 0) {
      showToast(`Nothing to sync; all chats use "${preview.target}".`);
      return;
    }
    const lines = (preview.groups ?? []).map((g) => `  ${g.provider}  →  ${preview.target}   (${g.count})`);
    openModal({
      title: "Sync chats to active provider",
      body: `Retag ${preview.total} chat(s) to "${preview.target}":\n\n${lines.join("\n")}\n\nQuit Codex Desktop first. Backed up and restorable.`,
      executeLabel: "Sync now",
      onExecute: () => apiPost("/api/config/sync", { confirmed: true })
    });
  } catch (error) {
    showToast(error.message);
  }
});

els.saveProfileButton.addEventListener("click", async () => {
  const label = window.prompt("Name this profile (snapshot of the current config.toml):");
  if (!label || !label.trim()) return;
  try {
    await apiPost("/api/config/save-profile", { label: label.trim() });
    showToast("Profile saved");
    await loadConfig();
  } catch (error) {
    showToast(error.message);
  }
});

els.profileList.addEventListener("click", (event) => {
  const applyButton = event.target.closest("[data-apply-profile]");
  if (applyButton) {
    const profile = state.config?.profiles?.find((p) => p.id === applyButton.dataset.applyProfile);
    previewAndApply({ profile: applyButton.dataset.applyProfile }, `Apply profile ${profile ? profile.label : ""}`);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-profile]");
  if (deleteButton) {
    const id = deleteButton.dataset.deleteProfile;
    const profile = state.config?.profiles?.find((p) => p.id === id);
    openModal({
      title: "Delete profile",
      body: `Delete saved profile "${profile ? profile.label : id}"?\nThis only removes the snapshot, not your live config.`,
      executeLabel: "Delete",
      onExecute: () => apiPost("/api/config/delete-profile", { id, confirmed: true })
    });
  }
});

els.modalClose.addEventListener("click", closeModal);
els.modalCancel.addEventListener("click", closeModal);
els.modal.addEventListener("click", (event) => { if (event.target === els.modal) closeModal(); });

loadAll();
