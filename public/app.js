const state = {
  codexHome: "",
  status: null,
  projects: [],
  threads: [],
  backups: [],
  selectedProject: "",
  selectedProvider: "",
  selectedThreadId: "",
  selectedBackup: null
};

const $ = (id) => document.getElementById(id);

const els = {
  codexHomeLabel: $("codexHomeLabel"),
  codexHomeInput: $("codexHomeInput"),
  refreshButton: $("refreshButton"),
  projectCount: $("projectCount"),
  projectList: $("projectList"),
  providerList: $("providerList"),
  statusGrid: $("statusGrid"),
  threadScope: $("threadScope"),
  searchInput: $("searchInput"),
  archivedOnly: $("archivedOnly"),
  clearFilters: $("clearFilters"),
  threadRows: $("threadRows"),
  selectionEmpty: $("selectionEmpty"),
  selectionDetails: $("selectionDetails"),
  confirmTrashThread: $("confirmTrashThread"),
  confirmDeleteProject: $("confirmDeleteProject"),
  backupList: $("backupList"),
  reloadBackups: $("reloadBackups"),
  modal: $("modal"),
  modalTitle: $("modalTitle"),
  modalBody: $("modalBody"),
  modalClose: $("modalClose"),
  modalCancel: $("modalCancel"),
  modalExecute: $("modalExecute"),
  toast: $("toast")
};

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  const codexHome = state.codexHome || els.codexHomeInput.value;
  if (codexHome) url.searchParams.set("codexHome", codexHome);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
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
  if (!value) return "";
  return value.replace(/^\/Users\/[^/]+/, "~");
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

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const stats = [
    ["SQLite", status.integrity, status.integrity === "ok" ? "ok" : "warn"],
    ["Threads", status.totals?.threads ?? 0, ""],
    ["Rollouts", status.rolloutFiles ?? 0, ""],
    ["Mismatches", (status.missingRolloutCount ?? 0) + (status.missingDbCount ?? 0) + (status.rolloutPathOutsideHomeCount ?? 0), "warn"]
  ];
  els.statusGrid.innerHTML = stats.map(([label, value, tone]) => `
    <div class="stat ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `).join("");
  els.codexHomeLabel.textContent = status.codexHome;
  if (!state.codexHome) {
    state.codexHome = status.codexHome;
    els.codexHomeInput.value = status.codexHome;
  }
}

function renderProjects() {
  els.projectCount.textContent = String(state.projects.length);
  els.projectList.innerHTML = state.projects.map((project) => {
    const active = project.path === state.selectedProject ? "active" : "";
    return `
      <button class="project-item ${active}" data-project="${escapeAttr(project.path)}" type="button">
        <div class="item-title">${escapeHtml(shortPath(project.path))}</div>
        <div class="item-meta">
          <span>${project.saved ? "saved" : "discovered"}</span>
          <span>${project.total} chats</span>
          <span>${project.archived} archived</span>
        </div>
      </button>
    `;
  }).join("");
}

function renderProviders() {
  const items = providerCounts();
  els.providerList.innerHTML = [
    `<button class="provider-item ${state.selectedProvider ? "" : "active"}" data-provider="" type="button">
      <div class="item-title">All providers</div>
      <div class="item-meta"><span>${state.status?.totals?.threads ?? 0} chats</span></div>
    </button>`,
    ...items.map(([provider, count]) => `
      <button class="provider-item ${provider === state.selectedProvider ? "active" : ""}" data-provider="${escapeAttr(provider)}" type="button">
        <div class="item-title">${escapeHtml(provider)}</div>
        <div class="item-meta"><span>${count} chats</span></div>
      </button>
    `)
  ].join("");
}

function renderThreads() {
  const threads = currentThreads();
  const scope = [
    state.selectedProject ? shortPath(state.selectedProject) : "All projects",
    state.selectedProvider || "all providers",
    els.archivedOnly.checked ? "archived only" : "active + archived"
  ];
  els.threadScope.textContent = `${scope.join(" / ")} - ${threads.length} shown`;
  els.threadRows.innerHTML = threads.map((thread) => {
    const selected = thread.id === state.selectedThreadId ? "selected" : "";
    return `
      <tr class="${selected}" data-thread="${escapeAttr(thread.id)}">
        <td>
          <div class="thread-title">${escapeHtml(thread.title || "(untitled)")}</div>
          <div class="thread-id">${escapeHtml(thread.id)}</div>
        </td>
        <td class="path-cell">${escapeHtml(shortPath(thread.cwd))}</td>
        <td><span class="badge">${escapeHtml(thread.model_provider)}</span></td>
        <td>${escapeHtml(formatDate(thread.updated_at))}</td>
        <td>${thread.archived ? "<span class=\"badge\">archived</span>" : ""}</td>
      </tr>
    `;
  }).join("");
}

function renderSelection() {
  const thread = state.threads.find((item) => item.id === state.selectedThreadId);
  const project = state.projects.find((item) => item.path === state.selectedProject);
  const hasSelection = Boolean(thread || project);
  els.selectionEmpty.classList.toggle("hidden", hasSelection);
  els.selectionDetails.classList.toggle("hidden", !hasSelection);
  els.confirmTrashThread.disabled = !thread;
  els.confirmDeleteProject.disabled = !project;
  if (!hasSelection) {
    els.selectionDetails.innerHTML = "";
    return;
  }
  const rows = thread
    ? [
      ["Chat", thread.title || "(untitled)"],
      ["Thread ID", thread.id],
      ["Project", shortPath(thread.cwd)],
      ["Provider", thread.model_provider],
      ["Rollout", shortPath(thread.rollout_path)]
    ]
    : [
      ["Project", shortPath(project.path)],
      ["Saved", project.saved ? "yes" : "no"],
      ["Chats", `${project.total} total, ${project.archived} archived`],
      ["Delete", "all exact-cwd chats"],
      ["Updated", project.updated_at ? formatDate(project.updated_at) : "-"]
    ];
  els.selectionDetails.innerHTML = rows.map(([label, value]) => `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `).join("");
}

function renderBackups() {
  if (!state.backups.length) {
    els.backupList.innerHTML = `<div class="empty">No chat-manager backups.</div>`;
    return;
  }
  els.backupList.innerHTML = state.backups.map((backup) => `
    <button class="backup-item" data-backup="${escapeAttr(backup.path)}" type="button">
      <div class="item-title">${escapeHtml(backup.name)}</div>
      <div class="item-meta">
        <span>${escapeHtml(backup.reason || "backup")}</span>
        <span>${backup.threadIds.length} threads</span>
      </div>
    </button>
  `).join("");
}

function renderAll() {
  renderStatus();
  renderProjects();
  renderProviders();
  renderThreads();
  renderSelection();
  renderBackups();
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
    if (state.selectedProject && !state.projects.some((project) => project.path === state.selectedProject)) {
      state.selectedProject = "";
    }
    await loadThreads();
    if (state.selectedThreadId && !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
      state.selectedThreadId = "";
    }
    renderAll();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadThreads() {
  state.threads = await apiGet("/api/threads", {
    project: state.selectedProject,
    provider: state.selectedProvider,
    archived: els.archivedOnly.checked ? "1" : ""
  });
}

async function refreshThreads() {
  try {
    await loadThreads();
    renderThreads();
    renderSelection();
  } catch (error) {
    showToast(error.message);
  }
}

function openModal({ title, body, executeLabel = "Execute", onExecute }) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  els.modalExecute.textContent = executeLabel;
  els.modalExecute.onclick = async () => {
    try {
      const result = await onExecute?.();
      closeModal();
      showToast("Done");
      await loadAll();
      if (result) console.log(result);
    } catch (error) {
      showToast(error.message);
    }
  };
  els.modal.classList.remove("hidden");
}

function closeModal() {
  els.modal.classList.add("hidden");
}

async function confirmTrashThread() {
  const thread = state.threads.find((item) => item.id === state.selectedThreadId);
  if (!thread) return;
  openModal({
    title: "Delete Chat",
    body: {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      provider: thread.model_provider,
      effect: "This chat row and its rollout file will be moved into a restorable backup."
    },
    executeLabel: "Delete Chat",
    onExecute: () => apiPost("/api/trash-thread", { threadId: thread.id, confirmed: true })
  });
}

async function confirmDeleteProject() {
  const project = state.projects.find((item) => item.path === state.selectedProject);
  if (!project) return;
  openModal({
    title: "Delete Project",
    body: {
      project: project.path,
      chats: project.total,
      archivedChats: project.archived,
      effect: "All chats whose cwd exactly matches this project path will be moved into a restorable backup."
    },
    executeLabel: "Delete Project",
    onExecute: () => apiPost("/api/delete-project", {
      project: project.path,
      confirmed: true
    })
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

els.refreshButton.addEventListener("click", loadAll);
els.reloadBackups.addEventListener("click", loadAll);
els.searchInput.addEventListener("input", renderThreads);
els.archivedOnly.addEventListener("change", refreshThreads);
els.clearFilters.addEventListener("click", async () => {
  state.selectedProject = "";
  state.selectedProvider = "";
  state.selectedThreadId = "";
  els.searchInput.value = "";
  els.archivedOnly.checked = false;
  await refreshThreads();
  renderProjects();
  renderProviders();
  renderSelection();
});

els.projectList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-project]");
  if (!button) return;
  state.selectedProject = button.dataset.project;
  state.selectedThreadId = "";
  await refreshThreads();
  renderProjects();
  renderSelection();
});

els.providerList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-provider]");
  if (!button) return;
  state.selectedProvider = button.dataset.provider;
  state.selectedThreadId = "";
  await refreshThreads();
  renderProviders();
  renderSelection();
});

els.threadRows.addEventListener("click", (event) => {
  const row = event.target.closest("[data-thread]");
  if (!row) return;
  state.selectedThreadId = row.dataset.thread;
  renderThreads();
  renderSelection();
});

els.backupList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-backup]");
  if (!button) return;
  const backup = state.backups.find((item) => item.path === button.dataset.backup);
  if (!backup) return;
  openModal({
    title: "Restore Backup",
    body: backup,
    executeLabel: "Restore",
    onExecute: () => apiPost("/api/restore", { backupDir: backup.path, confirmed: true })
  });
});

els.confirmTrashThread.addEventListener("click", confirmTrashThread);
els.confirmDeleteProject.addEventListener("click", confirmDeleteProject);
els.modalClose.addEventListener("click", closeModal);
els.modalCancel.addEventListener("click", closeModal);
els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) closeModal();
});

loadAll();
