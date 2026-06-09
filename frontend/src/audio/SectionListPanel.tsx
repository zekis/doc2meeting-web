/**
 * Slide-up panel showing numbered sections with titles.
 * Current section highlighted, completed sections checkmarked. Tap to jump.
 */

import Icon from "@mdi/react";
import { mdiCheck, mdiClose, mdiVolumeHigh } from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";

export function SectionListPanel() {
  const {
    sections,
    currentSectionIdx,
    completedSections,
    sectionListOpen,
    setSectionListOpen,
    jumpToSection,
  } = useAudioPlayer();

  if (!sectionListOpen) return null;

  return (
    <div
      className="section-list-backdrop"
      onClick={() => setSectionListOpen(false)}
    >
      <div
        className="section-list-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="section-list-header">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
            Sections
          </h3>
          <button
            className="icon-btn"
            onClick={() => setSectionListOpen(false)}
          >
            <Icon path={mdiClose} size={0.8} />
          </button>
        </header>

        <ol className="section-list-items">
          {sections.map((sec, i) => {
            const isCurrent = sec.sectionIdx === currentSectionIdx;
            const isCompleted = completedSections.has(sec.sectionIdx);

            return (
              <li key={sec.sectionIdx}>
                <button
                  className={`section-list-item ${isCurrent ? "active" : ""} ${isCompleted ? "completed" : ""}`}
                  onClick={() => {
                    jumpToSection(sec.sectionIdx);
                    setSectionListOpen(false);
                  }}
                >
                  <span className="section-list-num">
                    {isCompleted ? (
                      <Icon path={mdiCheck} size={0.65} />
                    ) : isCurrent ? (
                      <Icon path={mdiVolumeHigh} size={0.65} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="section-list-title truncate">
                    {sec.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
