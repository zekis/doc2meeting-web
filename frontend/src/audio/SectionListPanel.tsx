/**
 * Slide-up panel showing sections with expandable paragraphs.
 * Current section/paragraph highlighted, completed sections checkmarked. Tap to jump.
 */

import { useState, useEffect } from "react";
import Icon from "@mdi/react";
import { mdiCheck, mdiClose, mdiVolumeHigh, mdiVolumeMedium, mdiChevronDown, mdiChevronRight } from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";

/** Strip markdown syntax for plain-text previews. */
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

function truncateText(text: string, maxLen: number): string {
  const plain = stripMarkdown(text);
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen).trimEnd() + "...";
}

export function SectionListPanel() {
  const {
    sections,
    currentSectionIdx,
    currentParagraphIdx,
    completedSections,
    sectionListOpen,
    setSectionListOpen,
    jumpToSection,
    jumpToParagraph,
  } = useAudioPlayer();

  // Track which sections are expanded — auto-expand current section
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Auto-expand the current section when it changes
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.has(currentSectionIdx)) return prev;
      const next = new Set(prev);
      next.add(currentSectionIdx);
      return next;
    });
  }, [currentSectionIdx]);

  if (!sectionListOpen) return null;

  const toggleExpand = (sectionIdx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sectionIdx)) {
        next.delete(sectionIdx);
      } else {
        next.add(sectionIdx);
      }
      return next;
    });
  };

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
            const isExpanded = expanded.has(sec.sectionIdx);
            const hasParagraphs = sec.paragraphs.length > 1;

            return (
              <li key={sec.sectionIdx}>
                <div className="flex items-center">
                  {/* Expand/collapse toggle */}
                  {hasParagraphs ? (
                    <button
                      className="section-list-expand-btn"
                      onClick={() => toggleExpand(sec.sectionIdx)}
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      <Icon path={isExpanded ? mdiChevronDown : mdiChevronRight} size={0.65} />
                    </button>
                  ) : (
                    <span className="section-list-expand-spacer" />
                  )}

                  {/* Section button */}
                  <button
                    className={`section-list-item flex-1 ${isCurrent ? "active" : ""} ${isCompleted ? "completed" : ""}`}
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
                    {hasParagraphs && (
                      <span className="section-list-para-count">
                        {sec.paragraphs.length}
                      </span>
                    )}
                  </button>
                </div>

                {/* Paragraph sub-list */}
                {hasParagraphs && isExpanded && (
                  <ol className="section-list-paragraphs">
                    {sec.paragraphs.map((para, pIdx) => {
                      const isCurrentPara = isCurrent && currentParagraphIdx === pIdx;
                      const hasAudio = sec.narratorParagraphs.has(pIdx);
                      return (
                        <li key={pIdx}>
                          <button
                            className={`section-list-para-item ${isCurrentPara ? "active" : ""}`}
                            onClick={() => {
                              jumpToParagraph(sec.sectionIdx, pIdx);
                              setSectionListOpen(false);
                            }}
                          >
                            <Icon
                              path={isCurrentPara ? mdiVolumeHigh : mdiVolumeMedium}
                              size={0.45}
                              className={`section-list-para-icon ${hasAudio ? "has-audio" : "no-audio"}`}
                            />
                            <span className="section-list-para-text">
                              {truncateText(para, 80)}
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
  );
}
