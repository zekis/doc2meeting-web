import { useCallback, useEffect, useRef, useState } from "react";
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
import { UploadView } from "./components/UploadView";
import { WelcomeScreen, hasCompletedOnboarding } from "./pages/Welcome";
import { useAudioPlayer, PlayerPage, MiniPlayer } from "./audio";
import { DropZone } from "./components/DropZone";
import type { DropZoneHandle } from "./components/DropZone";
import type { UploadItem } from "./components/UploadQueue";
import { UploadQueue } from "./components/UploadQueue";
import { ToastContainer, useToast } from "./components/Toast";

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
  const audioPlayer = useAudioPlayer();

  // Upload state
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const { toasts, dismiss: dismissToast, toast } = useToast();
  const dropZoneRef = useRef<DropZoneHandle>(null);

  const triggerFilePicker = useCallback(() => {
    dropZoneRef.current?.openFilePicker();
  }, []);

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
      const doc = await api.openDocument(relPath);
      setOpenDoc(doc);
      setActiveTab("player");
      audioPlayer.loadDocument(doc, true);
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
      const doc = await api.openDocument(result.saved_rel_path);
      setOpenDoc(doc);
      setActiveTab("player");
      audioPlayer.loadDocument(doc, true);
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
    setActiveTab(tab);
  };

  const handleBackToLibrary = () => {
    setActiveTab("library");
  };

  const handleExpandPlayer = () => {
    if (openDoc) {
      setActiveTab("player");
    }
  };

  const handleUploadComplete = useCallback(() => {
    refreshTree();
    refreshRecents();
  }, []);

  const handleRetryUpload = useCallback(
    (id: string) => {
      const item = uploadItems.find((i) => i.id === id);
      if (!item) return;
      setUploadItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, status: "uploading" as const, progress: 0, error: undefined } : i))
      );
      api.uploadDocument(item.file, (pct) => {
        setUploadItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, status: "uploading" as const, progress: pct } : i))
        );
      }).then((result) => {
        setUploadItems((prev) =>
          prev.map((i) =>
            i.id === id
              ? { ...i, status: "done" as const, progress: 100, resultRelPath: result.rel_path }
              : i
          )
        );
        toast("success", `"${result.name}" uploaded successfully`);
        handleUploadComplete();
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setUploadItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, status: "error" as const, error: msg } : i))
        );
      });
    },
    [uploadItems, toast, handleUploadComplete]
  );

  const handleRemoveUpload = useCallback((id: string) => {
    setUploadItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const handleDismissAllUploads = useCallback(() => {
    setUploadItems((prev) => prev.filter((i) => i.status !== "done" && i.status !== "error"));
  }, []);

  const isPlayerView = activeTab === "player" && openDoc;

  return (
    <Layout activeTab={isPlayerView ? "player" : activeTab} onNavigate={handleNavigate}>
      <DropZone
        ref={dropZoneRef}
        onToast={toast}
        uploadItems={uploadItems}
        setUploadItems={setUploadItems}
        onUploadComplete={handleUploadComplete}
      >
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

        {isPlayerView ? (
          /* ---- Audio Player view ---- */
          <PlayerPage onBack={handleBackToLibrary} />
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
        ) : activeTab === "upload" ? (
          /* ---- Dedicated upload view ---- */
          <UploadView onUploadClick={triggerFilePicker} />
        ) : (
          /* ---- Library card grid + mini-player ---- */
          <>
            <DocumentLibrary
              documents={recents}
              loading={loading || recents.length === 0 && tree === null}
              onOpenDocument={handleOpenFile}
              uploadItems={uploadItems}
              onUpload={triggerFilePicker}
            />
            <MiniPlayer onExpand={handleExpandPlayer} />
          </>
        )}
      </DropZone>

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

      {/* Upload queue bottom sheet */}
      <UploadQueue
        items={uploadItems}
        onRetry={handleRetryUpload}
        onRemove={handleRemoveUpload}
        onDismissAll={handleDismissAllUploads}
      />

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
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
