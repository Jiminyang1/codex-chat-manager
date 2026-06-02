import { Trash2 } from "lucide-react";
import { formatDate, shortPath } from "../lib/format";
import type { Thread } from "../../../src/types";

function ThreadDetail({ thread, selectedProject, onDeleteThread, onDeleteProject }: {
  thread: Thread;
  selectedProject: string;
  onDeleteThread: () => void;
  onDeleteProject: () => void;
}) {
  const hasProject = Boolean(selectedProject);
  return (
    <div className="detail">
      <h2>{thread.title || "(untitled)"}</h2>
      <div className="kv"><span>ID</span><strong>{thread.id}</strong><span>Project</span><strong>{shortPath(thread.cwd)}</strong><span>Provider</span><strong>{thread.model_provider}</strong><span>Updated</span><strong>{formatDate(thread.updated_at)}</strong><span>Preview</span><strong>{thread.preview || thread.first_user_message || "-"}</strong></div>
      <div className="actions">
        <button className="danger ghost" onClick={onDeleteThread} type="button"><Trash2 size={15} /> Delete chat</button>
        <button className="danger ghost" onClick={onDeleteProject} disabled={!hasProject} type="button"><Trash2 size={15} /> Delete project</button>
      </div>
    </div>
  );
}

export { ThreadDetail };
