/**
 * Player page — the core product screen for reviewing documents via audio.
 *
 * Mobile: back arrow + doc title, scrollable review text, bottom player bar.
 * Desktop: two-pane — section list left, content + player right.
 */

import { useEffect, useRef } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
  mdiCheck,
  mdiDotsVertical,
  mdiVolumeHigh,
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";
import { AudioPlayerBar } from "./AudioPlayerBar";
import { SectionListPanel } from "./SectionListPanel";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface PlayerPageProps {
  onBack: () => void;
}

function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

export function PlayerPage({ onBack }: PlayerPageProps) {
  const {
    doc,
    playbackState,
    currentSectionIdx,
    currentParagraphIdx,
    sections,
    completedSections,
    jumpToSection,
  } = useAudioPlayer();

  const contentRef = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const hasScrolledRef = useRef(false);

  // Auto-scroll to current paragraph (skip initial mount to avoid layout glitch)
  useEffect(() => {
    const key = `${currentSectionIdx}-${currentParagraphIdx}`;
    const el = paragraphRefs.current.get(key);
    if (!el) return;

    if (!hasScrolledRef.current) {
      // First render — instant scroll, no animation to avoid visible reflow
      hasScrolledRef.current = true;
      el.scrollIntoView({ behavior: "instant", block: "center" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentSectionIdx, currentParagraphIdx]);

  if (!doc) {
    return (
      <div className="player-page">
        <div className="flex items-center justify-center flex-1 text-fg-muted">
          No document loaded. Select a document from the library.
        </div>
      </div>
    );
  }

  const currentSection = doc.sections.find((s) => s.idx === currentSectionIdx);
  const isFinished = playbackState === "finished";

  return (
    <div className="player-page">
      {/* Top header */}
      <div className="player-page-header">
        <button className="icon-btn" onClick={onBack} title="Back to library">
          <Icon path={mdiArrowLeft} size={0.9} />
        </button>
        <span className="player-page-title truncate" title={doc.rel_path}>
          {doc.name}
        </span>
        <button className="icon-btn" title="More options">
          <Icon path={mdiDotsVertical} size={0.85} />
        </button>
      </div>

      {/* Body: two-pane on desktop, single pane on mobile */}
      <div className="player-page-body">
        {/* Desktop sidebar — inline section list */}
        <div className="player-page-sidebar">
          <div className="player-sidebar-sections">
            <h3>Sections</h3>
            <ol>
              {sections.map((sec, i) => {
                const isCurrent = sec.sectionIdx === currentSectionIdx;
                const isCompleted = completedSections.has(sec.sectionIdx);
                return (
                  <li key={sec.sectionIdx}>
                    <button
                      className={`section-list-item ${isCurrent ? "active" : ""} ${isCompleted ? "completed" : ""}`}
                      onClick={() => jumpToSection(sec.sectionIdx)}
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

        {/* Main content area */}
        <div className="player-page-main">
          <div className="player-page-content" ref={contentRef}>
            {isFinished ? (
              <div className="player-finished">
                <h2>Review Complete</h2>
                <p>
                  All {doc.sections.length} sections have been reviewed.
                </p>
                <button
                  className="primary"
                  onClick={() => jumpToSection(doc.sections[0]?.idx ?? 0)}
                >
                  Play Again
                </button>
              </div>
            ) : (
              <div className="player-review-text">
                {doc.sections.map((sec) => (
                  <div key={sec.idx}>
                    <h2 className="player-section-heading">{sec.title}</h2>
                    {sec.paragraphs.map((para, pIdx) => {
                      const isActive =
                        sec.idx === currentSectionIdx && pIdx === currentParagraphIdx;
                      const refKey = `${sec.idx}-${pIdx}`;
                      return (
                        <div
                          key={refKey}
                          ref={(el) => {
                            if (el) paragraphRefs.current.set(refKey, el);
                            else paragraphRefs.current.delete(refKey);
                          }}
                          className={`player-paragraph ${isActive ? "active" : ""}`}
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(para),
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Audio player bar */}
          <AudioPlayerBar />
        </div>
      </div>

      {/* Mobile section list panel */}
      <SectionListPanel />
    </div>
  );
}
