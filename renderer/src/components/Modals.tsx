import React from "react";
import { Plus } from "lucide-react";
import {
  defaultProviderAuth,
  defaultProviderConfig,
  providerIdFromConfig,
  providerIdFromLabel,
  updateProviderIdInDraftConfig
} from "../lib/provider-helpers";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { ProviderProfile } from "../../../src/types";

type NewProviderDraft = {
  label: string;
  configText: string;
  authText: string;
  switch: boolean;
};
type ConfirmModalState = {
  title: string;
  body?: string;
  confirmLabel?: string;
  tone?: "primary" | "danger";
  hideCancel?: boolean;
  action: () => unknown | Promise<unknown>;
};
type ProfileEditorState = {
  profile: ProviderProfile;
  tab: "config" | "auth";
  drafts: { config: string; auth: string };
};

function NewProviderModal({ draft, setDraft, onCancel, onSubmit }: {
  draft: NewProviderDraft;
  setDraft: Dispatch<SetStateAction<NewProviderDraft>>;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const defaultId = providerIdFromLabel(draft.label) || "custom";
  const configText = draft.configText || defaultProviderConfig(defaultId);
  const authText = draft.authText || defaultProviderAuth();
  const providerId = providerIdFromConfig(configText);

  function update(patch: Partial<NewProviderDraft>) {
    setDraft({ ...draft, ...patch });
  }

  function updateLabel(value: string) {
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

function ConfirmModal({ modal, onCancel }: { modal: ConfirmModalState; onCancel: () => void }) {
  const tone = modal.tone === "danger" ? "danger" : "primary";
  return (
    <div className="modal">
      <div className="modal-card confirm-modal">
        <h2>{modal.title}</h2>
        <ModalMessage body={modal.body} />
        <div className="actions end">
          {!modal.hideCancel && <button onClick={onCancel} type="button">Cancel</button>}
          <button className={tone} onClick={modal.action} type="button">{modal.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

function ModalMessage({ body }: { body?: string }) {
  const paragraphs = String(body ?? "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    <div className="modal-message">
      {paragraphs.map((paragraph, index) => {
        const lines = paragraph.split("\n");
        return (
          <p key={`${index}-${paragraph.slice(0, 16)}`}>
            {lines.map((line, lineIndex) => (
              <React.Fragment key={`${lineIndex}-${line.slice(0, 16)}`}>
                {line}
                {lineIndex < lines.length - 1 && <br />}
              </React.Fragment>
            ))}
          </p>
        );
      })}
      {!paragraphs.length && <p>-</p>}
    </div>
  );
}

function ProfileEditor({ editor, setEditor, onCancel, onSave }: {
  editor: ProfileEditorState;
  setEditor: Dispatch<SetStateAction<ProfileEditorState | null>>;
  onCancel: () => void;
  onSave: () => void;
}) {
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

export { ConfirmModal, NewProviderModal, ProfileEditor };
