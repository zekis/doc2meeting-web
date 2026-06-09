import { useEffect, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
  mdiFileDocumentOutline,
  mdiPaperclip,
} from "@mdi/js";
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
import { Layout } from "./components/Layout";

export function App() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [recents, setRecents] = useState<DocumentSummary[]>([]);
  const [openDoc, setOpenDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"library" | "upload" | "player" | "settings">("library");

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
      setActiveTab("player");
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
      await refreshTree();
      setOpenDoc(await api.openDocument(result.saved_rel_path));
      setActiveTab("player");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleNavigate = (tab: "library" | "upload" | "player" | "settings") => {
    if (tab === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (tab === "library") {
      setOpenDoc(null);
    }
    setActiveTab(tab);
  };

  return (
    <Layout activeTab={openDoc ? "player" : activeTab} onNavigate={handleNavigate}>
      {error && (
        <div className="px-4 py-2 text-sm bg-bad/10 text-bad border-b border-border">
          {error}
        </div>
      )}
      {loading && (
        <div className="px-4 py-2 text-sm bg-surface text-fg-muted border-b border-border">
          working...
        </div>
      )}

      {openDoc ? (
        /* ---- Player / Doc Review view ---- */
        <div className="flex flex-col h-full min-h-0">
          {/* Sub-header for document context */}
          <div className="flex items-center gap-2 px-4 py-2 bg-surface border-b border-border shrink-0">
            <button
              onClick={() => { setOpenDoc(null); setActiveTab("library"); }}
              className="icon-btn"
              title="Back to library"
            >
              <Icon path={mdiArrowLeft} size={0.9} />
            </button>
            <span className="flex-1 min-w-0 text-sm font-medium truncate" title={openDoc.rel_path}>
              {openDoc.name}
            </span>
            <button
              className="icon-btn inline-flex items-center gap-1"
              onClick={() => setContextPickerOpen(true)}
              title="Choose reference documents"
            >
              <Icon path={mdiPaperclip} size={0.85} />
              <span className="text-xs text-fg-muted tabular-nums">
                {openDoc.context_paths.length}
              </span>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <DocReview doc={openDoc} onDocChanged={handleDocChanged} />
          </div>
        </div>
      ) : (
        /* ---- Library view ---- */
        <div className="w-full max-w-5xl mx-auto p-4 phone:p-6">
          <div className="grid grid-cols-1 tablet:grid-cols-2 gap-4 phone:gap-6">
            {/* File tree card */}
            <div className="bg-surface border border-border rounded-card p-4">
              {tree ? (
                <FileTree
                  tree={tree.tree as FileTreeNode}
                  rootLabel={tree.root}
                  activePath={null}
                  onSelectFile={handleOpenFile}
                  onConvertDocx={handleConvertDocx}
                />
              ) : (
                <p className="text-fg-muted p-4">Loading tree...</p>
              )}
            </div>
            {/* Recent documents card */}
            <div className="bg-surface border border-border rounded-card p-4">
              <h3 className="text-xs uppercase tracking-wider text-fg-muted mb-3">
                Recent
              </h3>
              {recents.length === 0 ? (
                <p className="text-fg-muted">No recently opened documents yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
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
        </div>
      )}

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
    </Layout>
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
    <li className="flex">
      <button
        className="w-full flex gap-3 items-start text-left bg-surface-elevated border border-border rounded-card p-3 text-fg cursor-pointer transition-colors hover:border-accent hover:bg-accent/5"
        onClick={onOpen}
        title={doc.rel_path}
      >
        <Icon path={mdiFileDocumentOutline} size={1.1} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{doc.name}</div>
          {folder && (
            <div className="text-xs text-fg-muted font-mono truncate mt-0.5">
              {folder}
            </div>
          )}
          <div className="text-xs text-fg-muted mt-1">
            opened {sinceOpened}
            {doc.context_paths.length > 0 && (
              <>
                {" "}· {doc.context_paths.length} context doc
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
