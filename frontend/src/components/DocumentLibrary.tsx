import { useState, useMemo } from "react";
import Icon from "@mdi/react";
import {
  mdiFileDocumentOutline,
  mdiLanguageMarkdown,
  mdiFilePdfBox,
  mdiFileWordBox,
  mdiSortCalendarDescending,
  mdiSortAlphabeticalAscending,
  mdiFileUploadOutline,
  mdiLoading,
  mdiDeleteOutline,
  mdiGoogleDrive,
  mdiMonitor,
  mdiPlus,
} from "@mdi/js";
import { api, type DocumentSummary } from "../api";
import type { UploadItem } from "./UploadQueue";

type SortMode = "recent" | "alpha";

interface DocumentLibraryProps {
  documents: DocumentSummary[];
  loading: boolean;
  onOpenDocument: (relPath: string) => void;
  onDeleteDocument?: (id: number) => void;
  uploadItems?: UploadItem[];
  onUpload?: () => void;
}

/** Derive file extension for type-based card styling. */
function getFileType(name: string): "word" | "markdown" | "pdf" | "other" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "word";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".pdf")) return "pdf";
  return "other";
}

const TYPE_CONFIG = {
  word: { color: "bg-blue-600", icon: mdiFileWordBox, label: "DOCX" },
  markdown: { color: "bg-zinc-600", icon: mdiLanguageMarkdown, label: "MD" },
  pdf: { color: "bg-red-600", icon: mdiFilePdfBox, label: "PDF" },
  other: { color: "bg-surface-elevated", icon: mdiFileDocumentOutline, label: "DOC" },
} as const;

function relativeTime(d: Date): string {
  const now = Date.now();
  const ms = now - d.getTime();
  if (ms < 0) return d.toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function DocumentLibrary({ documents, loading, onOpenDocument, onDeleteDocument, uploadItems = [], onUpload }: DocumentLibraryProps) {
  const [sort, setSort] = useState<SortMode>("recent");

  const { cloudDocs, localDocs } = useMemo(() => {
    const cloud = documents.filter((d) => d.on_drive);
    const local = documents.filter((d) => !d.on_drive);
    const sortFn = sort === "alpha"
      ? (a: DocumentSummary, b: DocumentSummary) => a.name.localeCompare(b.name)
      : (a: DocumentSummary, b: DocumentSummary) => new Date(b.last_opened_at).getTime() - new Date(a.last_opened_at).getTime();
    cloud.sort(sortFn);
    local.sort(sortFn);
    return { cloudDocs: cloud, localDocs: local };
  }, [documents, sort]);

  const sorted = useMemo(() => [...cloudDocs, ...localDocs], [cloudDocs, localDocs]);

  // Skeleton loading state
  if (loading && documents.length === 0) {
    return (
      <div className="w-full max-w-6xl mx-auto p-4 phone:p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Library</h2>
        </div>
        <div className="grid grid-cols-1 phone:grid-cols-2 tablet:grid-cols-3 laptop:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  // Empty state
  if (!loading && documents.length === 0) {
    return (
      <div className="w-full max-w-6xl mx-auto p-4 phone:p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Library</h2>
        </div>
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-32 h-32 rounded-full bg-surface-elevated flex items-center justify-center mb-6">
            <Icon path={mdiFileUploadOutline} size={2.5} className="text-fg-muted" />
          </div>
          <h3 className="text-lg font-medium mb-2">No documents yet</h3>
          <p className="text-fg-muted text-sm text-center max-w-xs mb-6">
            Upload a .docx, .md, or .pdf file to get started with your first review.
          </p>
          <button
            type="button"
            onClick={onUpload}
            className="px-5 py-2.5 rounded-btn bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity mb-4"
          >
            Upload Your First Document
          </button>
          <p className="text-fg-muted text-xs">
            or drag and drop files anywhere on this page
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto p-4 phone:p-6">
      {/* Header with sort toggle */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold">
          Library
          <span className="text-fg-muted text-sm font-normal ml-2">
            {documents.length} document{documents.length === 1 ? "" : "s"}
          </span>
        </h2>
        <button
          onClick={() => setSort(sort === "recent" ? "alpha" : "recent")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-sm text-fg-muted hover:text-fg hover:bg-surface-elevated transition-colors"
          title={sort === "recent" ? "Sort alphabetically" : "Sort by recent"}
        >
          <Icon
            path={sort === "recent" ? mdiSortCalendarDescending : mdiSortAlphabeticalAscending}
            size={0.7}
          />
          <span className="hidden phone:inline">
            {sort === "recent" ? "Recent" : "A–Z"}
          </span>
        </button>
      </div>

      {/* Processing cards for active uploads */}
      {uploadItems.filter((i) => i.status !== "error").filter((i) => i.status !== "done" || !sorted.some((d) => d.rel_path === i.resultRelPath)).length > 0 && (
        <div className="grid grid-cols-1 phone:grid-cols-2 tablet:grid-cols-3 laptop:grid-cols-4 gap-4 mb-6">
          {uploadItems
            .filter((i) => i.status !== "error")
            .filter((i) => i.status !== "done" || !sorted.some((d) => d.rel_path === i.resultRelPath))
            .map((item) => (
              <ProcessingCard key={item.id} item={item} />
            ))}
        </div>
      )}

      {/* Cloud Storage section */}
      {cloudDocs.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Icon path={mdiGoogleDrive} size={0.7} className="text-accent" />
            <h3 className="text-sm font-semibold text-fg-muted uppercase tracking-wide">
              Cloud Storage
            </h3>
            <span className="text-xs text-fg-muted">({cloudDocs.length})</span>
          </div>
          <div className="grid grid-cols-1 phone:grid-cols-2 tablet:grid-cols-3 laptop:grid-cols-4 gap-4">
            {cloudDocs.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onOpen={() => onOpenDocument(doc.rel_path)}
                onDelete={onDeleteDocument ? () => onDeleteDocument(doc.id) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Local Storage section */}
      {localDocs.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Icon path={mdiMonitor} size={0.7} className="text-fg-muted" />
            <h3 className="text-sm font-semibold text-fg-muted uppercase tracking-wide">
              This Device
            </h3>
            <span className="text-xs text-fg-muted">({localDocs.length})</span>
          </div>
          <div className="grid grid-cols-1 phone:grid-cols-2 tablet:grid-cols-3 laptop:grid-cols-4 gap-4">
            {localDocs.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onOpen={() => onOpenDocument(doc.rel_path)}
                onDelete={onDeleteDocument ? () => onDeleteDocument(doc.id) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Floating upload button */}
      {onUpload && (
        <button
          onClick={onUpload}
          className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-accent text-accent-fg shadow-lg hover:opacity-90 active:scale-95 transition-all flex items-center justify-center z-40"
          title="Upload document"
        >
          <Icon path={mdiPlus} size={1.2} />
        </button>
      )}
    </div>
  );
}

function DocumentCard({ doc, onOpen, onDelete }: { doc: DocumentSummary; onOpen: () => void; onDelete?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileType = getFileType(doc.name);
  const config = TYPE_CONFIG[fileType];
  const opened = new Date(doc.last_opened_at);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteDocument(doc.id);
      onDelete?.();
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <div
      onClick={onOpen}
      className="group flex flex-col bg-surface border border-border rounded-card overflow-hidden text-left cursor-pointer transition-all hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5 active:scale-[0.98] relative"
      title={doc.rel_path}
    >
      {/* Thumbnail */}
      <div className={`${config.color} flex items-center justify-center h-28 relative`}>
        <Icon path={config.icon} size={2} className="text-white/80" />
        <span className="absolute top-2 right-2 text-[0.6rem] font-bold uppercase tracking-wider text-white/60 bg-black/20 px-1.5 py-0.5 rounded">
          {config.label}
        </span>
        {/* Storage indicator badge */}
        {doc.on_drive ? (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[0.65rem] font-medium px-1.5 py-0.5 rounded-full bg-accent/20 text-accent">
            <Icon path={mdiGoogleDrive} size={0.4} />
            Drive
          </span>
        ) : (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[0.65rem] font-medium px-1.5 py-0.5 rounded-full bg-warn/20 text-warn" title="Not synced — only available on this device">
            <Icon path={mdiMonitor} size={0.4} />
            This device only
          </span>
        )}
        {/* Delete button — visible on hover */}
        {onDelete && !confirming && (
          <button
            onClick={handleDelete}
            className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-black/40 hover:bg-bad/80 text-white"
            title="Delete document"
          >
            <Icon path={mdiDeleteOutline} size={0.65} />
          </button>
        )}
      </div>

      {/* Confirm delete overlay */}
      {confirming && (
        <div
          className="absolute inset-0 z-10 bg-bg/90 flex flex-col items-center justify-center gap-3 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm text-fg text-center font-medium">Delete this document?</p>
          <p className="text-xs text-fg-muted text-center line-clamp-2">{doc.name}</p>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 rounded-btn bg-bad text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
            <button
              onClick={handleCancelDelete}
              className="px-3 py-1.5 rounded-btn bg-surface-elevated border border-border text-xs font-medium hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Card body */}
      <div className="flex flex-col gap-1.5 p-3 flex-1">
        <h3 className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-accent transition-colors">
          {doc.name}
        </h3>
        <div className="mt-auto flex items-center justify-between text-xs text-fg-muted">
          <span>{relativeTime(opened)}</span>
          {doc.context_paths.length > 0 && (
            <span>{doc.context_paths.length} ref{doc.context_paths.length === 1 ? "" : "s"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ProcessingCard({ item }: { item: UploadItem }) {
  const fileType = getFileType(item.file.name);
  const config = TYPE_CONFIG[fileType];

  return (
    <div className="flex flex-col bg-surface border border-accent/30 rounded-card overflow-hidden opacity-80">
      {/* Thumbnail */}
      <div className={`${config.color} flex items-center justify-center h-28 relative`}>
        <Icon path={config.icon} size={2} className="text-white/50" />
        <span className="absolute top-2 right-2 text-[0.6rem] font-bold uppercase tracking-wider text-white/60 bg-black/20 px-1.5 py-0.5 rounded">
          {config.label}
        </span>
        {/* Processing badge */}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[0.65rem] font-medium px-1.5 py-0.5 rounded-full bg-warn/20 text-warn">
          <Icon path={mdiLoading} size={0.4} className="animate-spin" />
          Processing
        </span>
        {/* Progress bar overlay */}
        {item.status === "uploading" && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-1.5 p-3 flex-1">
        <h3 className="text-sm font-medium leading-snug line-clamp-2 text-fg-muted">
          {item.file.name}
        </h3>
        <div className="mt-auto text-xs text-fg-muted">
          {item.status === "uploading" && `Uploading ${item.progress}%`}
          {item.status === "converting" && "Converting..."}
          {item.status === "queued" && "Queued"}
          {item.status === "done" && "Processing..."}
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col bg-surface border border-border rounded-card overflow-hidden">
      {/* Thumbnail skeleton */}
      <div className="h-28 bg-surface-elevated skeleton-pulse" />
      {/* Body skeleton */}
      <div className="p-3 flex flex-col gap-2">
        <div className="h-4 w-3/4 bg-surface-elevated rounded skeleton-pulse" />
        <div className="h-3 w-1/2 bg-surface-elevated rounded skeleton-pulse" />
        <div className="h-3 w-1/3 bg-surface-elevated rounded skeleton-pulse mt-2" />
      </div>
    </div>
  );
}
