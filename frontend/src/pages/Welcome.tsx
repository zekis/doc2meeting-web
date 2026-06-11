import Icon from "@mdi/react";
import {
  mdiFileUploadOutline,
  mdiBookOpenPageVariantOutline,
  mdiHeadphones,
} from "@mdi/js";

const ONBOARDING_KEY = "doc2meeting_onboarding_done";

export function hasCompletedOnboarding(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === "1";
}

export function markOnboardingDone(): void {
  localStorage.setItem(ONBOARDING_KEY, "1");
}

interface WelcomeScreenProps {
  onUpload: () => void;
  onBrowse: () => void;
}

const steps = [
  { icon: mdiFileUploadOutline, text: "Upload a document" },
  { icon: mdiBookOpenPageVariantOutline, text: "It's converted into an audiobook" },
  { icon: mdiHeadphones, text: "Listen on the go" },
] as const;

export function WelcomeScreen({ onUpload, onBrowse }: WelcomeScreenProps) {
  const handleUpload = () => {
    markOnboardingDone();
    onUpload();
  };

  const handleBrowse = () => {
    markOnboardingDone();
    onBrowse();
  };

  return (
    <div className="flex items-center justify-center min-h-[80vh] px-4">
      <div className="flex flex-col items-center gap-8 max-w-md w-full text-center">
        <div>
          <h1 className="text-2xl font-bold mb-2">Welcome to doc2meeting</h1>
          <p className="text-fg-muted text-sm">
            Turn any document into an audiobook you can listen to anywhere.
          </p>
        </div>

        <ul className="flex flex-col gap-4 w-full text-left">
          {steps.map((step, i) => (
            <li
              key={i}
              className="flex items-center gap-4 bg-surface border border-border rounded-card px-4 py-3"
            >
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-accent/15 text-accent shrink-0">
                <Icon path={step.icon} size={1} />
              </span>
              <span className="text-sm font-medium">{step.text}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-col items-center gap-3 w-full">
          <button
            className="primary w-full py-3 text-base font-semibold rounded-btn"
            onClick={handleUpload}
          >
            Upload Your First Document
          </button>
          <button
            className="link-btn text-sm"
            onClick={handleBrowse}
          >
            Browse library
          </button>
        </div>
      </div>
    </div>
  );
}
