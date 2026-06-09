import Icon from "@mdi/react";
import {
  mdiFileWordBox,
  mdiLanguageMarkdown,
  mdiFilePdfBox,
  mdiRefresh,
  mdiClose,
  mdiCheckCircle,
  mdiAlertCircle,
  mdiChevronDown,
  mdiChevronUp,
} from "@mdi/js";
import { useState } from "react";

export interface UploadItem {
  id: string;
  file: File;
  progress: number; // 0-100
  status: "queued" | "uploading" | "converting" | "done" | "error";
  error?: string;
  resultRelPath?: string;
}

interface UploadQueueProps {
  items: UploadItem[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onDismissAll: () => void;
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return mdiFileWordBox;
  if (lower.endsWith(".pdf")) return mdiFilePdfBox;
  return mdiLanguageMarkdown;
}

function fileIconColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "text-blue-400";
  if (lower.endsWith(".pdf")) return "text-red-400";
  return "text-fg-muted";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadQueue({ items, onRetry, onRemove, onDismissAll }: UploadQueueProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const activeCount = items.filter((i) => i.status === "uploading" || i.status === "queued" || i.status === "converting").length;
  const allDone = activeCount === 0;

  return (
    <div className="fixed bottom-14 tablet:bottom-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
      <div className="w-full max-w-lg mx-4 mb-4 pointer-events-auto bg-surface border border-border rounded-card shadow-2xl overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-elevated border-b border-border text-sm font-medium text-left"
        >
          {activeCount > 0 ? (
            <span className="text-accent">
              Uploading {activeCount} file{activeCount === 1 ? "" : "s"}...
            </span>
          ) : errorCount > 0 ? (
            <span className="text-bad">
              {errorCount} failed, {doneCount} complete
            </span>
          ) : (
            <span className="text-ok">
              {doneCount} file{doneCount === 1 ? "" : "s"} uploaded
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {allDone && (
              <button
                onClick={(e) => { e.stopPropagation(); onDismissAll(); }}
                className="text-fg-muted hover:text-fg text-xs px-2 py-0.5 bg-transparent border-none"
              >
                Clear
              </button>
            )}
            <Icon path={collapsed ? mdiChevronUp : mdiChevronDown} size={0.7} className="text-fg-muted" />
          </span>
        </button>

        {/* Items */}
        {!collapsed && (
          <ul className="max-h-60 overflow-y-auto divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <Icon path={fileIcon(item.file.name)} size={0.9} className={fileIconColor(item.file.name)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{item.file.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-fg-muted">{formatSize(item.file.size)}</span>
                    {item.status === "uploading" && (
                      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden max-w-[120px]">
                        <div
                          className="h-full bg-accent rounded-full transition-all duration-300"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                    {item.status === "converting" && (
                      <span className="text-xs text-warn">Converting...</span>
                    )}
                    {item.status === "queued" && (
                      <span className="text-xs text-fg-muted">Queued</span>
                    )}
                    {item.status === "error" && (
                      <span className="text-xs text-bad truncate max-w-[140px]" title={item.error}>
                        {item.error || "Failed"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0">
                  {item.status === "done" && (
                    <Icon path={mdiCheckCircle} size={0.8} className="text-ok" />
                  )}
                  {item.status === "error" && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onRetry(item.id)}
                        className="bg-transparent border-none p-0 w-6 h-6 flex items-center justify-center text-fg-muted hover:text-accent"
                        title="Retry"
                      >
                        <Icon path={mdiRefresh} size={0.7} />
                      </button>
                      <button
                        onClick={() => onRemove(item.id)}
                        className="bg-transparent border-none p-0 w-6 h-6 flex items-center justify-center text-fg-muted hover:text-bad"
                        title="Remove"
                      >
                        <Icon path={mdiClose} size={0.6} />
                      </button>
                    </div>
                  )}
                  {(item.status === "uploading" || item.status === "converting") && (
                    <span className="text-xs text-accent tabular-nums">{item.progress}%</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
