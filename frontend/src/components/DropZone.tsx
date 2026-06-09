import { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import Icon from "@mdi/react";
import {
  mdiFileWordBox,
  mdiLanguageMarkdown,
  mdiFilePdfBox,
  mdiPlus,
} from "@mdi/js";
import { api } from "../api";
import type { UploadItem } from "./UploadQueue";

const ACCEPTED_EXTENSIONS = [".docx", ".md", ".pdf"];
const ACCEPTED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "application/pdf",
  "text/plain", // .md files sometimes arrive as text/plain
];
const MAX_BATCH = 5;

interface DropZoneProps {
  children: React.ReactNode;
  onToast: (type: "error" | "success", text: string) => void;
  uploadItems: UploadItem[];
  setUploadItems: React.Dispatch<React.SetStateAction<UploadItem[]>>;
  onUploadComplete: () => void;
}

export interface DropZoneHandle {
  openFilePicker: () => void;
}

let _uploadId = 0;

function isAcceptedFile(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(ext);
}

export const DropZone = forwardRef<DropZoneHandle, DropZoneProps>(function DropZone(
  { children, onToast, uploadItems, setUploadItems, onUploadComplete },
  ref,
) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Process files — validate and queue
  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);

      // Validate file types
      const accepted: File[] = [];
      for (const f of fileArray) {
        if (!isAcceptedFile(f)) {
          onToast("error", `"${f.name}" is not a supported type. Use .docx, .md, or .pdf.`);
        } else {
          accepted.push(f);
        }
      }

      if (accepted.length === 0) return;

      // Check batch limit against active uploads
      const activeCount = uploadItems.filter(
        (i) => i.status === "queued" || i.status === "uploading" || i.status === "converting"
      ).length;
      if (activeCount + accepted.length > MAX_BATCH) {
        onToast("error", `Max ${MAX_BATCH} files at once. ${activeCount} already in progress.`);
        return;
      }

      // Create upload items
      const newItems: UploadItem[] = accepted.map((file) => ({
        id: `upload-${++_uploadId}`,
        file,
        progress: 0,
        status: "queued" as const,
      }));

      setUploadItems((prev) => [...prev, ...newItems]);

      // Start uploads
      for (const item of newItems) {
        uploadFile(item);
      }
    },
    [uploadItems, onToast, setUploadItems]
  );

  // Upload a single file
  const uploadFile = useCallback(
    async (item: UploadItem) => {
      setUploadItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: "uploading" as const, progress: 0 } : i))
      );

      try {
        const result = await api.uploadDocument(item.file, (pct) => {
          setUploadItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, progress: pct } : i))
          );
        });

        setUploadItems((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: "done" as const, progress: 100, resultRelPath: result.rel_path }
              : i
          )
        );

        onToast("success", `"${result.name}" uploaded successfully`);
        onUploadComplete();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setUploadItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "error" as const, error: msg } : i))
        );
      }
    },
    [setUploadItems, onToast, onUploadComplete]
  );

  // Retry a failed upload
  const retryUpload = useCallback(
    (id: string) => {
      const item = uploadItems.find((i) => i.id === id);
      if (item) uploadFile(item);
    },
    [uploadItems, uploadFile]
  );

  // Drag event handlers
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragging(false);
      if (e.dataTransfer?.files) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  // Attach window-level drag listeners
  useEffect(() => {
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  // Trigger file picker
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useImperativeHandle(ref, () => ({ openFilePicker }), [openFilePicker]);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        processFiles(e.target.files);
        e.target.value = ""; // reset so same file can be re-selected
      }
    },
    [processFiles]
  );

  return (
    <div className="relative h-full">
      {children}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,.md,.pdf"
        multiple
        onChange={handleFileInput}
        className="hidden"
      />

      {/* FAB (mobile only) — desktop/tablet uses the Upload nav tab instead */}
      <button
        onClick={openFilePicker}
        className="fixed tablet:hidden bottom-16 right-4 z-40 w-14 h-14 rounded-full bg-accent text-accent-fg shadow-lg flex items-center justify-center active:scale-95 transition-transform"
        title="Upload files"
      >
        <Icon path={mdiPlus} size={1.2} />
      </button>

      {/* Full-screen drag overlay */}
      {dragging && (
        <div className="fixed inset-0 z-[55] bg-bg/80 backdrop-blur-sm flex items-center justify-center">
          <div className="border-2 border-dashed border-accent rounded-2xl p-12 flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="flex items-center gap-3 text-accent">
              <Icon path={mdiFileWordBox} size={1.4} className="text-blue-400" />
              <Icon path={mdiLanguageMarkdown} size={1.4} className="text-fg-muted" />
              <Icon path={mdiFilePdfBox} size={1.4} className="text-red-400" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-fg">Drop files here</p>
              <p className="text-sm text-fg-muted mt-1">
                .docx, .md, .pdf — up to {MAX_BATCH} files
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

// Re-export for App to use the retry logic
export { type UploadItem };
