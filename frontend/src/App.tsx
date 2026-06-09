import { useEffect, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
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
import { DocumentLibrary } from "./components/DocumentLibrary";
import { WelcomeScreen, hasCompletedOnboarding } from "./pages/Welcome";

export function App() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [recents, setRecents] = useState<DocumentSummary[]>([]);
  const [openDoc, setOpenDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"library" | "upload" | "player" | "settings">("library");
  const [showOnboarding, setShowOnboarding] = useState(() => !hasCompletedOnboarding());

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
      ) : showOnboarding ? (
        /* ---- First-time onboarding ---- */
        <WelcomeScreen
          onUpload={() => {
            setShowOnboarding(false);
            setActiveTab("upload");
          }}
          onBrowse={() => {
            setShowOnboarding(false);
          }}
        />
      ) : (
        /* ---- Library card grid ---- */
        <DocumentLibrary
          documents={recents}
          loading={loading || recents.length === 0 && tree === null}
          onOpenDocument={handleOpenFile}
        />
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
