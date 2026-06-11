import { useEffect, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiFileWordBox,
  mdiLanguageMarkdown,
  mdiFilePdfBox,
  mdiCloudUploadOutline,
  mdiClose,
  mdiGoogleDrive,
} from "@mdi/js";
import { getDriveStatus, connectDrive, type UploadResult } from "../api";
import { DrivePicker } from "./DrivePicker";

const BANNER_DISMISSED_KEY = "doc2meeting_drive_banner_dismissed";

interface UploadViewProps {
  onUploadClick: () => void;
  onToast: (type: "error" | "success", text: string) => void;
  onUploadComplete: () => void;
}

export function UploadView({ onUploadClick, onToast, onUploadComplete }: UploadViewProps) {
  const [showBanner, setShowBanner] = useState(false);
  const [driveConnected, setDriveConnected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    getDriveStatus()
      .then((status) => {
        setDriveConnected(status.connected);
        if (!status.connected && localStorage.getItem(BANNER_DISMISSED_KEY) !== "1") {
          setShowBanner(true);
        }
      })
      .catch(() => {});
  }, []);

  const dismissBanner = () => {
    setShowBanner(false);
    localStorage.setItem(BANNER_DISMISSED_KEY, "1");
  };

  const handleImported = (_result: UploadResult) => {
    onUploadComplete();
  };

  return (
    <div className="w-full max-w-6xl mx-auto p-4 phone:p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold">Upload</h2>
      </div>

      {showBanner && (
        <div className="upload-drive-banner">
          <span className="text-sm">
            Connect Google Drive to save your documents securely in your own storage.{" "}
            <button className="upload-drive-banner-link" onClick={connectDrive}>
              Connect
            </button>
          </span>
          <button
            className="upload-drive-banner-close"
            onClick={dismissBanner}
            aria-label="Dismiss"
          >
            <Icon path={mdiClose} size={0.65} />
          </button>
        </div>
      )}
      <div className="flex flex-col items-center justify-center py-12 px-4 gap-6">
        {/* Drag-and-drop / local file picker */}
        <button
          type="button"
          onClick={onUploadClick}
          className="border-2 border-dashed border-accent/40 rounded-2xl p-10 phone:p-14 flex flex-col items-center gap-6 max-w-md w-full cursor-pointer hover:border-accent hover:bg-accent/5 transition-colors text-left"
        >
          <div className="w-16 h-16 rounded-full bg-accent/15 flex items-center justify-center">
            <Icon path={mdiCloudUploadOutline} size={1.5} className="text-accent" />
          </div>
          <div className="flex items-center gap-3">
            <Icon path={mdiFileWordBox} size={1.2} className="text-blue-400" />
            <Icon path={mdiLanguageMarkdown} size={1.2} className="text-fg-muted" />
            <Icon path={mdiFilePdfBox} size={1.2} className="text-red-400" />
          </div>
          <div className="text-center">
            <p className="text-lg font-medium text-fg mb-2">
              Drop files here or click to browse
            </p>
            <p className="text-sm text-fg-muted">
              Supports .docx, .md, and .pdf — up to 5 files at once
            </p>
          </div>
          <span className="px-5 py-2 rounded-btn bg-accent text-accent-fg font-medium text-sm">
            Choose Files
          </span>
        </button>

        {/* Divider */}
        <div className="flex items-center gap-4 max-w-md w-full">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-fg-muted uppercase tracking-wide">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Google Drive import */}
        {driveConnected ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-3 px-6 py-3.5 rounded-2xl border-2 border-border hover:border-accent/50 hover:bg-accent/5 transition-colors max-w-md w-full"
          >
            <Icon path={mdiGoogleDrive} size={1.2} className="text-accent" />
            <div className="text-left">
              <p className="text-sm font-medium text-fg">Import from Google Drive</p>
              <p className="text-xs text-fg-muted">Browse and select an existing document</p>
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={connectDrive}
            className="flex items-center gap-3 px-6 py-3.5 rounded-2xl border-2 border-border hover:border-accent/50 hover:bg-accent/5 transition-colors max-w-md w-full"
          >
            <Icon path={mdiGoogleDrive} size={1.2} className="text-fg-muted" />
            <div className="text-left">
              <p className="text-sm font-medium text-fg">Connect Google Drive</p>
              <p className="text-xs text-fg-muted">Import documents directly from your Drive</p>
            </div>
          </button>
        )}
      </div>

      <DrivePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onImported={handleImported}
        onToast={onToast}
      />
    </div>
  );
}
