/**
 * Player page — the core product screen for reviewing documents via audio.
 *
 * Mobile: back arrow + doc title, scrollable review text, bottom player bar.
 * Desktop: two/three-pane — section list left, content + player center,
 *          meeting panel right (when active).
 *
 * "Meet Now" starts a virtual meeting with an AI facilitator that reads the
 * document aloud, responds to user questions, and navigates on request.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
  mdiCheck,
  mdiChevronDown,
  mdiChevronRight,
  mdiPhone,
  mdiVolumeHigh,
  mdiVolumeMedium,
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";
import { AudioPlayerBar } from "./AudioPlayerBar";
import { SectionListPanel } from "./SectionListPanel";
import { MeetingPanel } from "./MeetingPanel";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface PlayerPageProps {
  onBack: () => void;
}

function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

/** Strip markdown syntax for plain-text previews (nav sidebar, section list). */
function stripMarkdown(md: string): string {
  return md
    .replace(/!\[.*?\]\(.*?\)/g, "")       // images
    .replace(/\[([^\]]*)\]\(.*?\)/g, "$1")  // links → text
    .replace(/(`{1,3})(.*?)\1/g, "$2")      // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")     // headings
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2") // bold/italic
    .replace(/~~(.*?)~~/g, "$1")            // strikethrough
    .replace(/^\s*[-*+]\s+/gm, "")          // unordered lists
    .replace(/^\s*\d+\.\s+/gm, "")          // ordered lists
    .replace(/^\s*>\s?/gm, "")              // blockquotes
    .replace(/\n{2,}/g, " ")                // collapse newlines
    .trim();
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
    jumpToParagraph,
  } = useAudioPlayer();

  const contentRef = useRef<HTMLDivElement>(null);

  // Desktop sidebar: track which sections are expanded
  const [sidebarExpanded, setSidebarExpanded] = useState<Set<number>>(new Set());

  // Meeting state
  const [meetingActive, setMeetingActive] = useState(false);

  // Auto-expand current section in sidebar
  useEffect(() => {
    setSidebarExpanded((prev) => {
      if (prev.has(currentSectionIdx)) return prev;
      const next = new Set(prev);
      next.add(currentSectionIdx);
      return next;
    });
  }, [currentSectionIdx]);

  const toggleSidebarExpand = useCallback((sectionIdx: number) => {
    setSidebarExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sectionIdx)) next.delete(sectionIdx);
      else next.add(sectionIdx);
      return next;
    });
  }, []);
  const paragraphRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const hasScrolledRef = useRef(false);

  // Auto-scroll to current paragraph
  useEffect(() => {
    const key = `${currentSectionIdx}-${currentParagraphIdx}`;
    const el = paragraphRefs.current.get(key);
    if (!el) return;

    if (!hasScrolledRef.current) {
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

  const isFinished = playbackState === "finished";

  return (
    <div className={`player-page ${meetingActive ? "meeting-active" : ""}`}>
      {/* Top header */}
      <div className="player-page-header">
        <button className="icon-btn" onClick={onBack} title="Back to library">
          <Icon path={mdiArrowLeft} size={0.9} />
        </button>
        <span className="player-page-title truncate" title={doc.rel_path}>
          {doc.name}
        </span>
        {!meetingActive && (
          <button
            className="meet-now-btn"
            onClick={() => setMeetingActive(true)}
            title="Start a virtual meeting"
          >
            <Icon path={mdiPhone} size={0.7} />
            <span className="meet-now-label">Meet Now</span>
          </button>
        )}
      </div>

      {/* Body: two/three-pane on desktop, single pane on mobile */}
      <div className="player-page-body">
        {/* Desktop sidebar — inline section list with paragraph expansion */}
        <div className="player-page-sidebar">
          <div className="player-sidebar-sections">
            <h3>Sections</h3>
            <ol>
              {sections.map((sec, i) => {
                const isCurrent = sec.sectionIdx === currentSectionIdx;
                const isCompleted = completedSections.has(sec.sectionIdx);
                const isExpanded = sidebarExpanded.has(sec.sectionIdx);
                const hasParagraphs = sec.paragraphs.length > 1;

                return (
                  <li key={sec.sectionIdx}>
                    <div className="flex items-center">
                      {hasParagraphs ? (
                        <button
                          className="section-list-expand-btn"
                          onClick={() => toggleSidebarExpand(sec.sectionIdx)}
                          title={isExpanded ? "Collapse" : "Expand"}
                        >
                          <Icon path={isExpanded ? mdiChevronDown : mdiChevronRight} size={0.65} />
                        </button>
                      ) : (
                        <span className="section-list-expand-spacer" />
                      )}
                      <button
                        className={`section-list-item flex-1 ${isCurrent ? "active" : ""} ${isCompleted ? "completed" : ""}`}
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
                        {hasParagraphs && (
                          <span className="section-list-para-count">
                            {sec.paragraphs.length}
                          </span>
                        )}
                      </button>
                    </div>

                    {hasParagraphs && isExpanded && (
                      <ol className="section-list-paragraphs">
                        {sec.paragraphs.map((para, pIdx) => {
                          const isCurrentPara = isCurrent && currentParagraphIdx === pIdx;
                          const hasAudio = sec.narratorParagraphs.has(pIdx);
                          return (
                            <li key={pIdx}>
                              <button
                                className={`section-list-para-item ${isCurrentPara ? "active" : ""}`}
                                onClick={() => jumpToParagraph(sec.sectionIdx, pIdx)}
                              >
                                <Icon
                                  path={isCurrentPara ? mdiVolumeHigh : mdiVolumeMedium}
                                  size={0.45}
                                  className={`section-list-para-icon ${hasAudio ? "has-audio" : "no-audio"}`}
                                />
                                <span className="section-list-para-text">
                                  {stripMarkdown(para).slice(0, 80)}
                                  {stripMarkdown(para).length > 80 ? "..." : ""}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
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
                <div className="flex gap-2 mt-2">
                  <button
                    className="primary"
                    onClick={() => jumpToSection(doc.sections[0]?.idx ?? 0)}
                  >
                    Play Again
                  </button>
                </div>
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
                        <div key={refKey} className="player-paragraph-wrapper">
                          <div
                            ref={(el) => {
                              if (el) paragraphRefs.current.set(refKey, el);
                              else paragraphRefs.current.delete(refKey);
                            }}
                            className={`player-paragraph ${isActive ? "active" : ""}`}
                          >
                            <div
                              className="player-paragraph-text"
                              dangerouslySetInnerHTML={{
                                __html: renderMarkdown(para),
                              }}
                            />
                          </div>
                        </div>
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

        {/* Meeting panel — right side on desktop, overlay on mobile */}
        {meetingActive && (
          <div className="player-page-meeting">
            <MeetingPanel
              docId={doc.id}
              docName={doc.name}
              onClose={() => setMeetingActive(false)}
            />
          </div>
        )}
      </div>

      {/* Mobile section list panel */}
      <SectionListPanel />
    </div>
  );
}
