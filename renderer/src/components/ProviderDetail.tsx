import { Check, ChevronRight, KeyRound } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ConfigOverview, JsonRecord, ProviderProfile } from "../../../src/types";

type ProviderItem = JsonRecord & {
  id: string;
  title: string;
  badge?: string;
  active?: boolean;
  current?: boolean;
  profile?: ProviderProfile;
  summary?: JsonRecord | null;
};
type ExpandedFiles = { config: boolean; auth: boolean };

function ProviderDetail({
  item,
  config,
  files,
  expandedFiles,
  setExpandedFiles,
  onUseOfficial,
  onUseProfile,
  onEdit,
  onDelete
}: {
  item: ProviderItem | null;
  config: ConfigOverview | null;
  files: JsonRecord;
  expandedFiles: ExpandedFiles;
  setExpandedFiles: Dispatch<SetStateAction<ExpandedFiles>>;
  onUseOfficial: () => void;
  onUseProfile: (profile: ProviderProfile) => void;
  onEdit: (profile: ProviderProfile) => void;
  onDelete: (profile: ProviderProfile) => void;
}) {
  if (!item) {
    return <div className="detail-empty"><KeyRound size={28} /><p>Select a provider.</p></div>;
  }

  const isOfficial = item.id === "official";
  const isCurrent = item.current === true;
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
        <span>Auth</span><strong>{isOfficial ? `OpenAI login (${config?.auth?.mode ?? "?"})` : isCurrent ? config?.auth?.exists ? "current auth.json" : "current config only" : profile?.hasAuth ? "profile auth snapshot" : "bearer token / unchanged auth"}</strong>
        {isOfficial && <><span>Snapshot</span><strong>{snapshotLabel}</strong></>}
        {isCurrent && <><span>Source</span><strong>detected, not saved as a profile</strong></>}
        <span>Active config</span><strong>{config?.modelProvider ?? "-"}</strong>
        <span>Bearer</span><strong>{config?.bearer?.present ? config.bearer.masked : "none"}</strong>
      </div>
      {!isCurrent && (
        <div className="actions">
          {isOfficial ? (
            <button className="primary" onClick={onUseOfficial} disabled={item.active} type="button">Use</button>
          ) : (
            <>
              <button className="primary" onClick={() => profile && onUseProfile(profile)} disabled={item.active || !profile} type="button">Use</button>
              <button onClick={() => profile && onEdit(profile)} disabled={!profile} type="button">Edit</button>
              <button className="danger-text" onClick={() => profile && onDelete(profile)} disabled={!profile} type="button">Delete</button>
            </>
          )}
        </div>
      )}
      <ProviderFiles files={files} expandedFiles={expandedFiles} setExpandedFiles={setExpandedFiles} isOfficial={isOfficial} isCurrent={isCurrent} />
    </div>
  );
}

function ProviderFiles({ files, expandedFiles, setExpandedFiles, isOfficial }: {
  files: JsonRecord;
  expandedFiles: ExpandedFiles;
  setExpandedFiles: Dispatch<SetStateAction<ExpandedFiles>>;
  isOfficial: boolean;
  isCurrent?: boolean;
}) {
  function toggle(file: keyof ExpandedFiles) {
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
      {files?.source === "current" && (
        <div className="file-empty">Detected from current Codex files. This provider was not added in Chat Manager and is not saved as a profile.</div>
      )}
      <FileDisclosure title="config.toml" value={files?.config ?? ""} expanded={expandedFiles.config} onToggle={() => toggle("config")} />
      <FileDisclosure title="auth.json" value={files?.auth ?? ""} expanded={expandedFiles.auth} onToggle={() => toggle("auth")} />
    </div>
  );
}

function FileDisclosure({ title, value, expanded, onToggle }: {
  title: string;
  value: string;
  expanded: boolean;
  onToggle: () => void;
}) {
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

export { ProviderDetail };
