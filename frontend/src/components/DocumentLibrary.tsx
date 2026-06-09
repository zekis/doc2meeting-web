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
} from "@mdi/js";
import type { DocumentSummary } from "../api";

type SortMode = "recent" | "alpha";

interface DocumentLibraryProps {
  documents: DocumentSummary[];
  loading: boolean;
  onOpenDocument: (relPath: string) => void;
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

export function DocumentLibrary({ documents, loading, onOpenDocument }: DocumentLibraryProps) {
  const [sort, setSort] = useState<SortMode>("recent");

  const sorted = useMemo(() => {
    const copy = [...documents];
    if (sort === "alpha") {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      copy.sort((a, b) => new Date(b.last_opened_at).getTime() - new Date(a.last_opened_at).getTime());
    }
    return copy;
  }, [documents, sort]);

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
            Open a document from the file tree to get started with your first review.
          </p>
          <div className="border-2 border-dashed border-border rounded-card px-8 py-6 text-center">
            <p className="text-fg-muted text-sm">
              Use the <span className="text-accent font-medium">Upload</span> tab to add documents
            </p>
          </div>
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

      {/* Card grid */}
      <div className="grid grid-cols-1 phone:grid-cols-2 tablet:grid-cols-3 laptop:grid-cols-4 gap-4">
        {sorted.map((doc) => (
          <DocumentCard
            key={doc.id}
            doc={doc}
            onOpen={() => onOpenDocument(doc.rel_path)}
          />
        ))}
      </div>
    </div>
  );
}

function DocumentCard({ doc, onOpen }: { doc: DocumentSummary; onOpen: () => void }) {
  const fileType = getFileType(doc.name);
  const config = TYPE_CONFIG[fileType];
  const opened = new Date(doc.last_opened_at);

  return (
    <button
      onClick={onOpen}
      className="group flex flex-col bg-surface border border-border rounded-card overflow-hidden text-left cursor-pointer transition-all hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5 active:scale-[0.98]"
      title={doc.rel_path}
    >
      {/* Thumbnail */}
      <div className={`${config.color} flex items-center justify-center h-28 relative`}>
        <Icon path={config.icon} size={2} className="text-white/80" />
        <span className="absolute top-2 right-2 text-[0.6rem] font-bold uppercase tracking-wider text-white/60 bg-black/20 px-1.5 py-0.5 rounded">
          {config.label}
        </span>
        {/* Status badge */}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-[0.65rem] font-medium px-1.5 py-0.5 rounded-full bg-ok/20 text-ok">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          Ready
        </span>
      </div>

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
    </button>
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
