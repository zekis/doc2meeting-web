import { useCallback, useEffect, useRef, useState } from "react";

export type ParaAction = "narrate" | "review" | "respond" | "clear";
import Icon from "@mdi/react";
import {
  mdiAutorenew,
  mdiCommentTextOutline,
  mdiContentSave,
  mdiFileEditOutline,
  mdiMicrophone,
  mdiPause,
  mdiPlay,
  mdiPlaylistPlay,
  mdiSkipNext,
  mdiSpeedometer,
} from "@mdi/js";
import {
  api,
  DocumentDetail,
  ReviewDetail,
  SectionDetail,
} from "../api";
import { usePlayer } from "../usePlayer";
import { useVoiceInput } from "../useVoiceInput";
import { SectionNav } from "./SectionNav";
import { SectionBlock } from "./SectionBlock";

interface Props {
  doc: DocumentDetail;
  onDocChanged: (d: DocumentDetail) => void;
}

interface BatchProgress {
  label: string;       // "section 3" or "document"
  done: number;
  total: number;
}

export function DocReview({ doc: initialDoc, onDocChanged }: Props) {
  const [doc, setDoc] = useState<DocumentDetail>(initialDoc);
  const [activeIdx, setActiveIdx] = useState<number | null>(
    initialDoc.sections[0]?.idx ?? null
  );
  const [saving, setSaving] = useState(false);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  // Sentinel for cancelling a batch run.
  const cancelRef = useRef(false);

  const gridRef = useRef<HTMLDivElement>(null);

  // Reset local state if the parent swaps in a new document.
  useEffect(() => {
    setDoc(initialDoc);
    setActiveIdx(initialDoc.sections[0]?.idx ?? null);
    setSavedMessage(null);
  }, [initialDoc.id]);

  const refreshDoc = async () => {
    try {
      const fresh = await api.getDocument(initialDoc.id);
      setDoc(fresh);
      onDocChanged(fresh);
    } catch {}
  };

  // Patch the doc state in-place after a per-paragraph review action.
  const updateSection = (
    sectionIdx: number,
    mutate: (sec: SectionDetail) => SectionDetail
  ) => {
    setDoc((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.idx === sectionIdx ? mutate(s) : s)),
    }));
  };

  const handleReviewCreated = (sectionIdx: number, r: ReviewDetail) => {
    updateSection(sectionIdx, (s) => ({ ...s, reviews: [...s.reviews, r] }));
  };

  const handleReviewUpdated = (sectionIdx: number, r: ReviewDetail) => {
    updateSection(sectionIdx, (s) => ({
      ...s,
      reviews: s.reviews.map((x) => (x.id === r.id ? r : x)),
    }));
    refreshDoc();
  };

  const handleJump = (sectionIdx: number) => {
    setActiveIdx(sectionIdx);
    const el = document.getElementById(`section-${sectionIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSavedMessage(null);
    try {
      const result = await api.saveVersion(doc.id);
      setSavedMessage(`Saved → ${result.saved_rel_path}`);
    } catch (e) {
      setSavedMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMarkup = async () => {
    setSavingMarkup(true);
    setSavedMessage(null);
    try {
      const result = await api.saveMarkup(doc.id);
      setSavedMessage(
        `Markup saved → ${result.saved_rel_path} (${result.review_count} review${result.review_count === 1 ? "" : "s"})`
      );
    } catch (e) {
      setSavedMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSavingMarkup(false);
    }
  };

  // Walk a list of (section_idx, paragraph_idx) targets sequentially,
  // skipping any that already have at least one review. The optimistic
  // updates in handleReviewCreated keep the UI in sync without re-fetching.
  const runBatch = async (
    label: string,
    targets: { sectionIdx: number; paragraphIdx: number }[]
  ) => {
    cancelRef.current = false;
    setBatch({ label, done: 0, total: targets.length });
    try {
      let i = 0;
      for (const t of targets) {
        if (cancelRef.current) break;
        // Re-check the latest doc state: a paragraph might have been reviewed
        // between when we queued the batch and now (manual click, prior batch).
        const sec = doc.sections.find((s) => s.idx === t.sectionIdx);
        const already = sec?.reviews.some(
          (r) => r.paragraph_idx === t.paragraphIdx
        );
        if (!already) {
          try {
            const r = await api.generateParagraphReview(
              doc.id,
              t.sectionIdx,
              t.paragraphIdx
            );
            handleReviewCreated(t.sectionIdx, r);
          } catch (e) {
            console.error("review failed", t, e);
          }
        }
        i += 1;
        setBatch({ label, done: i, total: targets.length });
      }
    } finally {
      setBatch(null);
      cancelRef.current = false;
      refreshDoc();
    }
  };

  const handleReviewSection = (sectionIdx: number) => {
    const sec = doc.sections.find((s) => s.idx === sectionIdx);
    if (!sec) return;
    const reviewedParas = new Set(sec.reviews.map((r) => r.paragraph_idx));
    const targets = sec.paragraphs
      .map((_, i) => i)
      .filter((i) => !reviewedParas.has(i))
      .map((paragraphIdx) => ({ sectionIdx, paragraphIdx }));
    if (targets.length === 0) return;
    runBatch(`section ${sectionIdx + 1}`, targets);
  };

  const handleCancelBatch = () => {
    cancelRef.current = true;
  };

  // Highlight the section currently in view.
  useEffect(() => {
    if (!gridRef.current) return;
    const root = gridRef.current.querySelector(".para-grid");
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const raw = (visible[0].target as HTMLElement).dataset.sectionIdx;
          const idx = raw !== undefined ? Number(raw) : NaN;
          if (!Number.isNaN(idx) && idx !== activeIdx) setActiveIdx(idx);
        }
      },
      { root, rootMargin: "-30% 0px -60% 0px", threshold: 0 }
    );
    root.querySelectorAll<HTMLElement>("[data-section-idx]").forEach((el) =>
      observer.observe(el)
    );
    return () => observer.disconnect();
    // We intentionally only re-observe when section indices change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.sections.map((s) => s.idx).join(",")]);

  const acceptedTotal = doc.sections.reduce(
    (acc, s) => acc + s.accepted_count,
    0
  );
  const totalParas = doc.sections.reduce((acc, s) => acc + s.paragraphs.length, 0);
  const reviewedParas = doc.sections.reduce(
    (acc, s) =>
      acc + new Set(s.reviews.map((r) => r.paragraph_idx)).size,
    0
  );
  const unreviewedParas = totalParas - reviewedParas;

  const batchRunning = batch !== null;
  const [withReview, setWithReview] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [voiceComments, setVoiceComments] = useState(false);
  const [autoContinue, setAutoContinue] = useState(false);
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const [playbackRate, setPlaybackRate] = useState(1);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  // Cost-per-paragraph estimate. Prefer the actual average from this doc's
  // history; fall back to a rough constant scaled by the active toolbar
  // flags (responder adds ~$0.005, editor adds ~$0.007). Calibrated against
  // typical SAT-style paragraphs.
  const DEFAULT_PER_PARA =
    0.007 + (withReview ? 0.005 : 0) + (autoAccept ? 0.007 : 0);
  const estPerPara =
    reviewedParas > 0 ? doc.total_cost_usd / reviewedParas : DEFAULT_PER_PARA;
  const estToComplete = unreviewedParas * estPerPara;

  // The pump-based player calls staged endpoints directly; we just need to
  // mirror the resulting Review row back into doc state so the UI updates.
  // If we already have a row for the same (section, paragraph), patch it
  // in place — otherwise treat it as a freshly-created review.
  const handleReviewFromPlayer = useCallback(
    (r: ReviewDetail) => {
      setDoc((d) => ({
        ...d,
        sections: d.sections.map((s) =>
          s.idx === r.section_idx
            ? {
                ...s,
                reviews: s.reviews.some((x) => x.id === r.id)
                  ? s.reviews.map((x) => (x.id === r.id ? r : x))
                  : [...s.reviews, r],
              }
            : s
        ),
      }));
    },
    []
  );

  const player = usePlayer(doc, {
    withReview,
    autoAccept,
    autoContinue,
    playbackRate,
    onReviewUpdated: handleReviewFromPlayer,
  });

  // Per-paragraph action orchestrator (Narrate / Review / Respond / Clear).
  // Each action hits the appropriate staged endpoint, plays the resulting
  // audio (where there is any), and — when Auto Continue is on — chains the
  // same action to the next paragraph after the audio ends.
  const actionAudioRef = useRef<HTMLAudioElement | null>(null);
  const actionEpochRef = useRef(0);
  const [activeAction, setActiveAction] = useState<{
    sectionIdx: number;
    paragraphIdx: number;
    action: ParaAction;
    state: "loading" | "playing";
  } | null>(null);
  const activeActionRef = useRef(activeAction);
  activeActionRef.current = activeAction;

  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    a.playbackRate = playbackRateRef.current;
    actionAudioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
      actionAudioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep action audio + every audio element inside the doc grid in sync
  // with the global playbackRate. Re-runs when the rate changes or when
  // new reviews/audios are rendered.
  useEffect(() => {
    if (actionAudioRef.current) {
      actionAudioRef.current.playbackRate = playbackRate;
    }
    const audios = document.querySelectorAll<HTMLAudioElement>(
      ".para-grid audio"
    );
    audios.forEach((a) => {
      a.playbackRate = playbackRate;
    });
  }, [playbackRate, doc.sections]);

  // Flat list of (sectionIdx, paragraphIdx) used to find the "next paragraph"
  // for action chaining.
  const flatTargets = doc.sections.flatMap((s) =>
    s.paragraphs.map((_, i) => ({ sectionIdx: s.idx, paragraphIdx: i }))
  );

  const stopAction = useCallback(() => {
    actionEpochRef.current++;
    const a = actionAudioRef.current;
    if (a) {
      a.onended = null;
      a.pause();
    }
    setActiveAction(null);
  }, []);

  const triggerAction = useCallback(
    async (
      action: ParaAction,
      sectionIdx: number,
      paragraphIdx: number
    ): Promise<void> => {
      // Re-clicking the same action on the same paragraph cancels it.
      const cur = activeActionRef.current;
      if (
        cur &&
        cur.action === action &&
        cur.sectionIdx === sectionIdx &&
        cur.paragraphIdx === paragraphIdx
      ) {
        stopAction();
        return;
      }

      const epoch = ++actionEpochRef.current;

      if (action === "clear") {
        try {
          await api.clearParagraphReviews(doc.id, sectionIdx, paragraphIdx);
          setDoc((d) => ({
            ...d,
            sections: d.sections.map((s) =>
              s.idx === sectionIdx
                ? {
                    ...s,
                    reviews: s.reviews.filter(
                      (r) => r.paragraph_idx !== paragraphIdx
                    ),
                  }
                : s
            ),
          }));
        } catch {}
        return;
      }

      setActiveAction({ sectionIdx, paragraphIdx, action, state: "loading" });
      let url: string | null = null;
      try {
        if (action === "narrate") {
          const r = await api.getParagraphNarrator(
            doc.id,
            sectionIdx,
            paragraphIdx
          );
          url = r.narrator_audio_url;
        } else if (action === "review") {
          const r = await api.stageReviewer(doc.id, sectionIdx, paragraphIdx);
          handleReviewFromPlayer(r);
          url = r.reviewer_audio_url;
        } else {
          const r = await api.stageResponse(doc.id, sectionIdx, paragraphIdx);
          handleReviewFromPlayer(r);
          url = r.response_audio_url;
        }
      } catch (e) {
        if (epoch === actionEpochRef.current) setActiveAction(null);
        return;
      }
      if (epoch !== actionEpochRef.current) return;
      if (!url) {
        setActiveAction(null);
        return;
      }

      const audio = actionAudioRef.current;
      if (!audio) {
        setActiveAction(null);
        return;
      }
      audio.onended = null;
      audio.src = url;
      audio.currentTime = 0;
      try {
        await audio.play();
      } catch {
        if (epoch === actionEpochRef.current) setActiveAction(null);
        return;
      }
      setActiveAction({ sectionIdx, paragraphIdx, action, state: "playing" });
      audio.onended = () => {
        if (epoch !== actionEpochRef.current) return;
        if (autoContinueRef.current) {
          const idx = flatTargets.findIndex(
            (t) =>
              t.sectionIdx === sectionIdx && t.paragraphIdx === paragraphIdx
          );
          const next =
            idx >= 0 && idx < flatTargets.length - 1
              ? flatTargets[idx + 1]
              : null;
          if (next) {
            triggerAction(action, next.sectionIdx, next.paragraphIdx);
            return;
          }
        }
        setActiveAction(null);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.id, doc.sections]
  );

  // Voice comments — VAD-driven mic capture, transcribed by Whisper, appended
  // to the current paragraph's user_comment. We pause the player on speech
  // detection and resume after the transcript is saved.
  const playerRef = useRef(player);
  playerRef.current = player;
  const wasPausedByVoiceRef = useRef(false);

  const voice = useVoiceInput({
    enabled: voiceComments,
    onSpeechStart: () => {
      const p = playerRef.current;
      if (p.state === "playing" || p.state === "loading") {
        wasPausedByVoiceRef.current = true;
        p.pause();
      }
    },
    onAudioCaptured: async (blob) => {
      const p = playerRef.current;
      const target = p.current;
      if (!target) return;
      try {
        const result = await api.voiceComment(
          doc.id,
          target.sectionIdx,
          target.paragraphIdx,
          blob
        );
        if (result.review) handleReviewFromPlayer(result.review);
      } finally {
        if (wasPausedByVoiceRef.current) {
          wasPausedByVoiceRef.current = false;
          // Resume from the same paragraph/segment we paused on.
          p.play();
        }
      }
    },
  });

  // Auto-scroll the now-playing paragraph into view so the doc tracks playback.
  useEffect(() => {
    if (!player.current) return;
    const el = document.querySelector<HTMLElement>(
      `[data-para-key="s${player.current.sectionIdx}-p${player.current.paragraphIdx}"]`
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [player.currentIndex, player.current?.sectionIdx, player.current?.paragraphIdx]);

  return (
    <div className="review-grid-2col">
      <aside className="pane pane-left">
        <SectionNav
          sections={doc.sections}
          activeIdx={activeIdx}
          onSelect={handleJump}
          onReviewSection={handleReviewSection}
          batchRunning={batchRunning}
        />
      </aside>

      <main className="pane pane-main">
        {(doc.structure_changed || doc.stale_review_count > 0) && (
          <div className="banner banner-warn">
            {doc.structure_changed && (
              <span>
                File changed on disk since last open — review alignment may
                drift.{" "}
              </span>
            )}
            {doc.stale_review_count > 0 && (
              <span>
                {doc.stale_review_count} review
                {doc.stale_review_count === 1 ? "" : "s"} no longer aligned to a
                paragraph (hidden).
              </span>
            )}
          </div>
        )}

        <div className="doc-toolbar">
          {/* Playback */}
          {player.state === "playing" || player.state === "loading" ? (
            <button
              className="icon-btn"
              onClick={player.pause}
              title="Pause"
            >
              <Icon path={mdiPause} size={0.95} />
            </button>
          ) : (
            <button
              className="icon-btn"
              onClick={player.play}
              disabled={player.total === 0}
              title={player.state === "paused" ? "Resume" : "Play all"}
            >
              <Icon path={mdiPlay} size={0.95} />
            </button>
          )}
          <button
            className={`icon-toggle ${autoContinue ? "active" : ""}`}
            onClick={() => {
              setAutoContinue(!autoContinue);
              if (autoContinue) stopAction();
            }}
            title="Auto continue — keep playing the next paragraph automatically when the current one finishes"
          >
            <Icon path={mdiPlaylistPlay} size={0.95} />
          </button>
          <button
            className={`icon-toggle speed-toggle ${playbackRate !== 1 ? "active" : ""}`}
            onClick={() => {
              const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];
              const i = speeds.indexOf(playbackRate);
              setPlaybackRate(speeds[(i + 1) % speeds.length]);
            }}
            title={`Playback speed ${playbackRate}× — click to cycle`}
          >
            <Icon path={mdiSpeedometer} size={0.9} />
            <span className="speed-label">{playbackRate}×</span>
          </button>
          <button
            className="icon-btn"
            onClick={player.skipNext}
            disabled={
              player.total === 0 ||
              player.currentIndex >= player.total - 1 ||
              player.state === "idle"
            }
            title="Skip to next paragraph"
          >
            <Icon path={mdiSkipNext} size={0.95} />
          </button>

          {/* Player toggles */}
          <button
            className={`icon-toggle ${withReview ? "active" : ""}`}
            onClick={() => {
              const on = !withReview;
              setWithReview(on);
              if (!on) setAutoAccept(false);
            }}
            title="With review — play reviewer commentary and narrator reply after each paragraph"
          >
            <Icon path={mdiCommentTextOutline} size={0.9} />
          </button>
          <button
            className={`icon-toggle ${autoAccept ? "active" : ""}`}
            onClick={() => setAutoAccept(!autoAccept)}
            disabled={!withReview}
            title={
              withReview
                ? "Auto accept — apply the editor's rewrite and play a conversational narrator reply"
                : "Enable With review first"
            }
          >
            <Icon path={mdiAutorenew} size={0.9} />
          </button>
          <button
            className={`icon-toggle ${voiceComments ? "active" : ""}`}
            onClick={() => setVoiceComments(!voiceComments)}
            title="Voice comments — your speech is transcribed and appended to the current paragraph's notes"
          >
            <Icon path={mdiMicrophone} size={0.9} />
            {voiceComments && voice.state !== "idle" && (
              <span className={`mic-dot mic-dot-${voice.state}`} />
            )}
          </button>

          {/* Player status pill */}
          {(player.state === "playing" ||
            player.state === "paused" ||
            player.state === "loading" ||
            player.processedCount > 0) && (
            <span
              className={`player-status player-${player.state}`}
              title={`Playing paragraph ${player.currentIndex + 1} of ${player.total}; ${player.processedCount} narrator clip${player.processedCount === 1 ? "" : "s"} prepared`}
            >
              {player.currentIndex >= 0 ? player.currentIndex + 1 : 0}/
              {player.total}
              {player.currentSegment && player.currentSegment !== "narrator" && (
                <span className="player-segment"> · {player.currentSegment}</span>
              )}
              <span className="player-prepared">
                {" "}· {player.processedCount} ready
              </span>
            </span>
          )}

          {/* Stats sit in the middle/right — flex absorbs the space */}
          <span className="toolbar-stat">
            {reviewedParas}/{totalParas} reviewed · {acceptedTotal} accepted ·{" "}
            <span
              className="toolbar-cost"
              title="OpenAI agent + TTS spend across every review on this document"
            >
              ${doc.total_cost_usd.toFixed(4)}
            </span>
            {unreviewedParas > 0 && (
              <span
                className="toolbar-cost-est"
                title={
                  reviewedParas > 0
                    ? `Based on average cost per paragraph reviewed so far ($${(
                        doc.total_cost_usd / reviewedParas
                      ).toFixed(4)}/para) × ${unreviewedParas} unreviewed paragraphs.`
                    : `Rough estimate at $${estPerPara.toFixed(
                        3
                      )}/para — exact cost depends on paragraph length and which agents run (With review, Auto accept).`
                }
              >
                {" "}· est. ${estToComplete.toFixed(2)}
              </span>
            )}
          </span>

          {/* Save actions on the right */}
          <button
            className="icon-btn"
            onClick={handleSave}
            disabled={saving || batchRunning || acceptedTotal === 0}
            title={
              acceptedTotal === 0
                ? "No accepted replacements to apply yet"
                : "Save as next version — write a new _v<N>.md alongside the original with accepted edits applied"
            }
          >
            <Icon path={mdiContentSave} size={0.95} />
          </button>
          <button
            className="icon-btn"
            onClick={handleSaveMarkup}
            disabled={savingMarkup || batchRunning || reviewedParas === 0}
            title={
              reviewedParas === 0
                ? "No reviews to export yet"
                : "Save markup only — write a _markup_v<N>.md notes file for an external party to apply"
            }
          >
            <Icon path={mdiFileEditOutline} size={0.95} />
          </button>

          {/* Transient messages tucked underneath */}
          {batch && (
            <div className="toolbar-batch">
              <span>
                Reviewing {batch.label} — {batch.done}/{batch.total}
              </span>
              <button className="ghost small-btn" onClick={handleCancelBatch}>
                cancel
              </button>
            </div>
          )}
          {savedMessage && !batch && (
            <span className="toolbar-msg">{savedMessage}</span>
          )}
          {player.error && (
            <span className="toolbar-msg toolbar-msg-err">
              Player: {player.error}
            </span>
          )}
          {voice.error && (
            <span className="toolbar-msg toolbar-msg-err">
              Mic: {voice.error}
            </span>
          )}
        </div>

        <div className="para-grid" ref={gridRef}>
          <div className="col-head col-head-mark">Document</div>
          <div className="col-head col-head-bubble">Review</div>

          {doc.sections.map((s) => (
            <SectionBlock
              key={s.idx}
              section={s}
              nowPlayingParagraphIdx={
                player.current?.sectionIdx === s.idx
                  ? player.current.paragraphIdx
                  : null
              }
              activeAction={
                activeAction?.sectionIdx === s.idx ? activeAction : null
              }
              onAction={(action, pi) => triggerAction(action, s.idx, pi)}
              onReviewUpdated={(r) => handleReviewUpdated(s.idx, r)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
