import { useState, useCallback, useEffect } from "react";
import Icon from "@mdi/react";
import {
  mdiGoogleDrive,
  mdiFolder,
  mdiFileDocumentOutline,
  mdiFileWordBox,
  mdiFilePdfBox,
  mdiLanguageMarkdown,
  mdiArrowLeft,
  mdiMagnify,
  mdiClose,
  mdiLoading,
  mdiHome,
} from "@mdi/js";
import { browseDriveFiles, importDriveFile, type DriveFile, type UploadResult } from "../api";

interface DrivePickerProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: UploadResult) => void;
  onToast: (type: "error" | "success", text: string) => void;
}

interface BreadcrumbItem {
  id: string | null; // null = root
  name: string;
}

function fileIcon(file: DriveFile): string {
  if (file.isFolder) return mdiFolder;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return mdiFileWordBox;
  if (lower.endsWith(".pdf")) return mdiFilePdfBox;
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return mdiLanguageMarkdown;
  return mdiFileDocumentOutline;
}

function fileIconColor(file: DriveFile): string {
  if (file.isFolder) return "text-yellow-400";
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "text-blue-400";
  if (lower.endsWith(".pdf")) return "text-red-400";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text-fg-muted";
  return "text-fg-muted";
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DrivePicker({ open, onClose, onImported, onToast }: DrivePickerProps) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([{ id: null, name: "My Drive" }]);
  const [search, setSearch] = useState("");
  const [searchActive, setSearchActive] = useState(false);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;

  const loadFiles = useCallback(async (folderId: string | null, query?: string) => {
    setLoading(true);
    try {
      const result = await browseDriveFiles({
        folderId: folderId ?? undefined,
        query: query || undefined,
      });
      setFiles(result.files);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load files";
      onToast("error", msg);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  // Load files when modal opens or folder changes
  useEffect(() => {
    if (!open) return;
    if (searchActive && search) {
      loadFiles(null, search);
    } else {
      loadFiles(currentFolderId);
    }
  }, [open, currentFolderId, searchActive, search, loadFiles]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setBreadcrumbs([{ id: null, name: "My Drive" }]);
      setSearch("");
      setSearchActive(false);
      setFiles([]);
      setImporting(null);
    }
  }, [open]);

  const handleFolderClick = (folder: DriveFile) => {
    setSearch("");
    setSearchActive(false);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setSearch("");
    setSearchActive(false);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleBack = () => {
    if (searchActive) {
      setSearch("");
      setSearchActive(false);
      return;
    }
    if (breadcrumbs.length > 1) {
      setBreadcrumbs((prev) => prev.slice(0, -1));
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) {
      setSearchActive(true);
    }
  };

  const handleClearSearch = () => {
    setSearch("");
    setSearchActive(false);
  };

  const handleImport = async (file: DriveFile) => {
    setImporting(file.id);
    try {
      const result = await importDriveFile(file.id, file.name);
      onToast("success", `"${file.name}" imported from Google Drive`);
      onImported(result);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Import failed";
      onToast("error", msg);
    } finally {
      setImporting(null);
    }
  };

  if (!open) return null;

  const canGoBack = breadcrumbs.length > 1 || searchActive;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface border border-border rounded-card w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <Icon path={mdiGoogleDrive} size={1} className="text-accent shrink-0" />
          <h2 className="text-lg font-semibold flex-1">Google Drive</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-btn hover:bg-surface-elevated transition-colors text-fg-muted hover:text-fg"
            title="Close"
          >
            <Icon path={mdiClose} size={0.8} />
          </button>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSearch} className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <Icon path={mdiMagnify} size={0.7} className="text-fg-muted shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your Drive..."
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted outline-none"
          />
          {search && (
            <button type="button" onClick={handleClearSearch} className="text-fg-muted hover:text-fg">
              <Icon path={mdiClose} size={0.6} />
            </button>
          )}
        </form>

        {/* Breadcrumbs / navigation */}
        {!searchActive && (
          <div className="flex items-center gap-1 px-4 py-2 text-xs text-fg-muted overflow-x-auto">
            {canGoBack && (
              <button onClick={handleBack} className="shrink-0 p-0.5 rounded hover:bg-surface-elevated">
                <Icon path={mdiArrowLeft} size={0.6} />
              </button>
            )}
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && <span className="text-fg-muted/50">/</span>}
                <button
                  onClick={() => handleBreadcrumbClick(i)}
                  className={`hover:text-fg transition-colors ${i === breadcrumbs.length - 1 ? "text-fg font-medium" : ""}`}
                >
                  {i === 0 ? <Icon path={mdiHome} size={0.55} className="inline" /> : crumb.name}
                </button>
              </span>
            ))}
          </div>
        )}
        {searchActive && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-fg-muted">
            <button onClick={handleBack} className="shrink-0 p-0.5 rounded hover:bg-surface-elevated">
              <Icon path={mdiArrowLeft} size={0.6} />
            </button>
            <span>Search results for "{search}"</span>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Icon path={mdiLoading} size={1.2} className="text-accent animate-spin" />
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-fg-muted">
              <Icon path={mdiFolder} size={2} className="mb-3 opacity-30" />
              <p className="text-sm">
                {searchActive ? "No matching files found" : "No supported files here"}
              </p>
              <p className="text-xs mt-1">Supported: .docx, .md, .pdf</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {files.map((file) => (
                <button
                  key={file.id}
                  onClick={() => (file.isFolder ? handleFolderClick(file) : handleImport(file))}
                  disabled={importing !== null}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-elevated transition-colors disabled:opacity-50"
                >
                  <Icon path={fileIcon(file)} size={0.9} className={fileIconColor(file) + " shrink-0"} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg truncate">{file.name}</p>
                    {!file.isFolder && (
                      <p className="text-xs text-fg-muted">
                        {formatSize(file.size)}
                        {file.modifiedTime && ` · ${new Date(file.modifiedTime).toLocaleDateString()}`}
                      </p>
                    )}
                  </div>
                  {importing === file.id && (
                    <Icon path={mdiLoading} size={0.7} className="text-accent animate-spin shrink-0" />
                  )}
                  {!file.isFolder && importing !== file.id && (
                    <span className="text-xs text-accent font-medium shrink-0">Import</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border text-xs text-fg-muted">
          Select a .docx, .md, or .pdf file to import
        </div>
      </div>
    </div>
  );
}
