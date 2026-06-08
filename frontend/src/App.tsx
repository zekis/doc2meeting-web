import { useEffect, useState } from "react";
import Icon from "@mdi/react";
import { mdiArrowLeft, mdiCog, mdiFileDocumentOutline, mdiPaperclip } from "@mdi/js";
import {
  api,
  DocumentDetail,
  DocumentSummary,
  FileTreeNode,
  TreeResponse,
} from "./api";
import { FileTree } from "./components/FileTree";
import { DocReview } from "./components/DocReview";
import { SettingsModal } from "./components/SettingsModal";

export function App() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [recents, setRecents] = useState<DocumentSummary[]>([]);
  const [openDoc, setOpenDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshTree = async () => {
    try {
      setTree(await api.getTree());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const refreshRecents = async () => {
    try {
      setRecents(await api.listDocuments());
    } catch {
      // recents are a nice-to-have on the dashboard; swallow errors so the
      // dashboard still renders the tree.
    }
  };

  useEffect(() => {
    refreshTree();
    refreshRecents();
  }, []);

  const handleOpenFile = async (relPath: string) => {
    setLoading(true);
    setError(null);
    try {
      setOpenDoc(await api.openDocument(relPath));
      // Update recents on next dashboard visit.
      refreshRecents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleContext = async (relPath: string, on: boolean) => {
    if (!openDoc) return;
    const next = on
      ? Array.from(new Set([...openDoc.context_paths, relPath]))
      : openDoc.context_paths.filter((p) => p !== relPath);
    setLoading(true);
    setError(null);
    try {
      setOpenDoc(await api.setContextPaths(openDoc.id, next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDocChanged = (d: DocumentDetail) => setOpenDoc(d);

  const handleConvertDocx = async (relPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.convertDocx(relPath);
      // Refresh the tree so the new .md shows up, then open it for review.
      await refreshTree();
      setOpenDoc(await api.openDocument(result.saved_rel_path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        {openDoc ? (
          <>
            <button
              className="icon-btn"
              onClick={() => setOpenDoc(null)}
              title="Back to dashboard"
            >
              <Icon path={mdiArrowLeft} size={0.9} />
            </button>
            <span className="topbar-doc-name" title={openDoc.rel_path}>
              {openDoc.name}
            </span>
            <button
              className="icon-btn topbar-context-btn"
              onClick={() => setContextPickerOpen(true)}
              title="Choose reference documents the reviewer should consider"
            >
              <Icon path={mdiPaperclip} size={0.85} />
              <span className="topbar-context-count">
                {openDoc.context_paths.length}
              </span>
            </button>
          </>
        ) : (
          tree && (
            <span className="topbar-root" title={tree.root_abs}>
              {tree.root}
            </span>
          )
        )}
        <button
          className="icon-btn topbar-settings-btn"
          onClick={() => setSettingsOpen(true)}
          title="Voice and tone settings"
        >
          <Icon path={mdiCog} size={0.9} />
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-banner">working...</div>}

      <div className={`app-body ${openDoc ? "app-body-doc" : "app-body-dash"}`}>
        {!openDoc ? (
          <div className="dashboard">
            <div className="dashboard-tree pane">
              {tree ? (
                <FileTree
                  tree={tree.tree as FileTreeNode}
                  rootLabel={tree.root}
                  activePath={null}
                  onSelectFile={handleOpenFile}
                  onConvertDocx={handleConvertDocx}
                />
              ) : (
                <p className="empty">Loading tree...</p>
              )}
            </div>
            <div className="dashboard-recents">
              <h3 className="dashboard-recents-head">Recent</h3>
              {recents.length === 0 ? (
                <p className="empty">No recently opened documents yet.</p>
              ) : (
                <ul className="recent-card-list">
                  {recents.map((r) => (
                    <RecentCard
                      key={r.id}
                      doc={r}
                      onOpen={() => handleOpenFile(r.rel_path)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <main className="pane pane-doc">
            <DocReview doc={openDoc} onDocChanged={handleDocChanged} />
          </main>
        )}
      </div>

      {contextPickerOpen && openDoc && tree && (
        <ContextPickerModal
          tree={tree.tree as FileTreeNode}
          rootLabel={tree.root}
          openDocPath={openDoc.rel_path}
          contextPaths={openDoc.context_paths}
          onToggle={handleToggleContext}
          onClose={() => setContextPickerOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

interface ContextPickerProps {
  tree: FileTreeNode;
  rootLabel: string;
  openDocPath: string;
  contextPaths: string[];
  onToggle: (relPath: string, on: boolean) => void;
  onClose: () => void;
}

function RecentCard({
  doc,
  onOpen,
}: {
  doc: DocumentSummary;
  onOpen: () => void;
}) {
  const folder =
    doc.rel_path.includes("/")
      ? doc.rel_path.slice(0, doc.rel_path.lastIndexOf("/"))
      : "";
  const opened = new Date(doc.last_opened_at);
  const sinceOpened = relativeTime(opened);

  return (
    <li className="recent-card">
      <button
        className="recent-card-btn"
        onClick={onOpen}
        title={doc.rel_path}
      >
        <Icon path={mdiFileDocumentOutline} size={1.1} />
        <div className="recent-card-body">
          <div className="recent-card-name">{doc.name}</div>
          {folder && (
            <div className="recent-card-folder">{folder}</div>
          )}
          <div className="recent-card-meta">
            opened {sinceOpened}
            {doc.context_paths.length > 0 && (
              <>
                {" "}
                · {doc.context_paths.length} context doc
                {doc.context_paths.length === 1 ? "" : "s"}
              </>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function relativeTime(d: Date): string {
  const now = Date.now();
  const ms = now - d.getTime();
  if (ms < 0) return d.toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString();
}

function ContextPickerModal({
  tree,
  rootLabel,
  openDocPath,
  contextPaths,
  onToggle,
  onClose,
}: ContextPickerProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Context documents</h2>
          <button className="link-btn" onClick={onClose}>
            close
          </button>
        </header>
        <p className="modal-help">
          Tick any reference document the reviewer should consult while
          reviewing <code>{openDocPath}</code>. Contents are bundled into the
          (cached) system prompt for each per-paragraph review.
        </p>
        <div className="modal-body">
          <FileTree
            tree={tree}
            rootLabel={rootLabel}
            contextPaths={contextPaths}
            activePath={openDocPath}
            onToggleContext={onToggle}
          />
        </div>
      </div>
    </div>
  );
}
