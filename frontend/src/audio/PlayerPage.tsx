/**
 * Player page — the core product screen for reviewing documents via audio.
 *
 * Mobile: back arrow + doc title, scrollable review text, bottom player bar.
 * Desktop: two-pane — section list left, content + player right.
 *
 * Includes STT (speech-to-text) voice comments: mic icons per paragraph,
 * floating mic for talk-while-playing, comment display, and markdown export.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
  mdiCheck,
  mdiChevronDown,
  mdiChevronRight,
  mdiClose,
  mdiDelete,
  mdiDownload,
  mdiMicrophone,
  mdiVolumeHigh,
  mdiVolumeMedium,
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";
import { AudioPlayerBar } from "./AudioPlayerBar";
import { SectionListPanel } from "./SectionListPanel";
import { useSpeechRecognition, isSpeechSupported } from "./useSpeechRecognition";
import { api, UserCommentData } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface PlayerPageProps {
  onBack: () => void;
  /** Expose recording state so parent can render a nav-bar mic button on mobile */
  onRecordingStateChange?: (isRecording: boolean, toggle: () => void) => void;
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

/** Group comments by "sectionIdx-paragraphIdx" key */
function commentsByParagraph(comments: UserCommentData[]): Map<string, UserCommentData[]> {
  const map = new Map<string, UserCommentData[]>();
  for (const c of comments) {
    const key = `${c.section_idx}-${c.paragraph_idx}`;
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return map;
}

export function PlayerPage({ onBack, onRecordingStateChange }: PlayerPageProps) {
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

  // --- Comments state ---
  const [comments, setComments] = useState<UserCommentData[]>([]);
  const commentMap = commentsByParagraph(comments);

  // --- STT state ---
  const sttSupported = isSpeechSupported();
  const {
    isListening,
    interimTranscript,
    startListening,
    stopListening,
  } = useSpeechRecognition();

  // Which paragraph the mic is currently recording for: null = not recording
  const [recordingTarget, setRecordingTarget] = useState<{
    sectionIdx: number;
    paragraphIdx: number;
  } | null>(null);

  // Load comments when document changes
  useEffect(() => {
    if (!doc) return;
    api.listComments(doc.id).then(setComments).catch(() => {});
  }, [doc?.id]);

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

  // --- STT handlers ---
  const handleStartRecording = useCallback(
    (sectionIdx: number, paragraphIdx: number) => {
      if (!sttSupported) return;
      // If already recording somewhere, stop that first
      if (recordingTarget) {
        handleStopRecording();
      }
      setRecordingTarget({ sectionIdx, paragraphIdx });
      startListening();
    },
    [sttSupported, recordingTarget, startListening]
  );

  const handleStopRecording = useCallback(async () => {
    if (!doc || !recordingTarget) return;
    const target = recordingTarget;
    setRecordingTarget(null);
    const text = await stopListening();
    if (text.trim()) {
      api
        .createComment(doc.id, target.sectionIdx, target.paragraphIdx, text.trim())
        .then((c) => setComments((prev) => [...prev, c]))
        .catch(() => {});
    }
  }, [doc, recordingTarget, stopListening]);

  const handleDeleteComment = useCallback(
    (commentId: number) => {
      if (!doc) return;
      api
        .deleteComment(doc.id, commentId)
        .then(() => setComments((prev) => prev.filter((c) => c.id !== commentId)))
        .catch(() => {});
    },
    [doc]
  );

  const handleExport = useCallback(async () => {
    if (!doc) return;
    try {
      const md = await api.exportComments(doc.id);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc.name.replace(/\.[^.]+$/, "")}-comments.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, [doc]);

  // Floating mic — records against currently playing paragraph (also used by nav bar button)
  const handleFloatingMicToggle = useCallback(() => {
    if (isListening && recordingTarget) {
      handleStopRecording();
    } else {
      handleStartRecording(currentSectionIdx, currentParagraphIdx);
    }
  }, [
    isListening,
    recordingTarget,
    currentSectionIdx,
    currentParagraphIdx,
    handleStartRecording,
    handleStopRecording,
  ]);

  // Push recording state to parent for the mobile nav bar mic button
  useEffect(() => {
    onRecordingStateChange?.(isListening && !!recordingTarget, handleFloatingMicToggle);
  }, [isListening, recordingTarget, handleFloatingMicToggle, onRecordingStateChange]);

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
  const hasComments = comments.length > 0;

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
        {hasComments && (
          <button
            className="icon-btn"
            onClick={handleExport}
            title="Export comments as Markdown"
          >
            <Icon path={mdiDownload} size={0.85} />
          </button>
        )}
      </div>

      {/* Body: two-pane on desktop, single pane on mobile */}
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
                                  path={isCurrentPara ? mdiVolumeHigh : hasAudio ? mdiVolumeMedium : mdiVolumeMedium}
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
                {hasComments && (
                  <p className="text-sm text-fg-muted mt-2">
                    You left {comments.length} comment{comments.length !== 1 ? "s" : ""}.
                  </p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    className="primary"
                    onClick={() => jumpToSection(doc.sections[0]?.idx ?? 0)}
                  >
                    Play Again
                  </button>
                  {hasComments && (
                    <button className="secondary" onClick={handleExport}>
                      Export Comments
                    </button>
                  )}
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
                      const paraComments = commentMap.get(refKey) ?? [];
                      const isRecordingHere =
                        recordingTarget?.sectionIdx === sec.idx &&
                        recordingTarget?.paragraphIdx === pIdx;

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
                            {/* Per-paragraph mic button */}
                            {sttSupported && (
                              <button
                                className={`player-para-mic ${isRecordingHere ? "recording" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isRecordingHere) {
                                    handleStopRecording();
                                  } else {
                                    handleStartRecording(sec.idx, pIdx);
                                  }
                                }}
                                title={
                                  isRecordingHere
                                    ? "Stop recording"
                                    : "Record voice comment"
                                }
                              >
                                <Icon
                                  path={isRecordingHere ? mdiClose : mdiMicrophone}
                                  size={0.6}
                                />
                              </button>
                            )}
                          </div>

                          {/* Interim transcript while recording */}
                          {isRecordingHere && interimTranscript && (
                            <div className="player-comment-interim">
                              {interimTranscript}
                            </div>
                          )}

                          {/* Existing comments */}
                          {paraComments.length > 0 && (
                            <div className="player-comments">
                              {paraComments.map((c) => (
                                <div key={c.id} className="player-comment">
                                  <span className="player-comment-text">
                                    {c.text}
                                  </span>
                                  <button
                                    className="player-comment-delete"
                                    onClick={() => handleDeleteComment(c.id)}
                                    title="Delete comment"
                                  >
                                    <Icon path={mdiDelete} size={0.5} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
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
      </div>

      {/* Mobile section list panel */}
      <SectionListPanel />

      {/* Floating mic — talk while playing (hidden on mobile, shown in nav bar instead) */}
      {sttSupported && !isFinished && (
        <button
          className={`player-floating-mic ${isListening ? "recording" : ""}`}
          onClick={handleFloatingMicToggle}
          title={isListening ? "Stop recording" : "Record voice comment"}
        >
          <Icon path={isListening ? mdiClose : mdiMicrophone} size={1.2} />
        </button>
      )}
    </div>
  );
}
