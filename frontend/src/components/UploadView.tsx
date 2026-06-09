import Icon from "@mdi/react";
import {
  mdiFileWordBox,
  mdiLanguageMarkdown,
  mdiFilePdfBox,
  mdiCloudUploadOutline,
} from "@mdi/js";

interface UploadViewProps {
  onUploadClick: () => void;
}

export function UploadView({ onUploadClick }: UploadViewProps) {
  return (
    <div className="w-full max-w-6xl mx-auto p-4 phone:p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold">Upload</h2>
      </div>
      <div className="flex flex-col items-center justify-center py-12 px-4">
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
      </div>
    </div>
  );
}
