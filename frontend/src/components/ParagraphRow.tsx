import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiCommentTextOutline,
  mdiLoading,
  mdiMicrophone,
  mdiReplyOutline,
  mdiTrashCanOutline,
  mdiVolumeHigh,
} from "@mdi/js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, ReviewDetail } from "../api";
import { ParaAction } from "./DocReview";

interface Props {
  sectionIdx: number;
  paragraphIdx: number;
  text: string;
  reviews: ReviewDetail[];
  nowPlaying?: boolean;
  /** Action this paragraph is currently running, if any. */
  activeAction:
    | { action: ParaAction; state: "loading" | "playing" }
    | null;
  onAction: (action: ParaAction) => void;
  onReviewUpdated: (r: ReviewDetail) => void;
}

export function ParagraphRow({
  sectionIdx,
  paragraphIdx,
  text,
  reviews,
  nowPlaying,
  activeAction,
  onAction,
  onReviewUpdated,
}: Props) {

  // Most recent review wins.
  const latest = reviews[reviews.length - 1];

  // When the editor agent (Week 2) populates proposed_replacement on an
  // accepted review, we render the original with strikethrough above the
  // replacement. Otherwise we just render the current text.
  const hasReplacement =
    !!latest &&
    latest.status === "accepted" &&
    !!latest.proposed_replacement &&
    latest.proposed_replacement.trim() !== text.trim();

  const originalHtml = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text]
  );
  const replacementHtml = useMemo(() => {
    if (!latest?.proposed_replacement) return "";
    return DOMPurify.sanitize(
      marked.parse(latest.proposed_replacement, { async: false }) as string
    );
  }, [latest?.proposed_replacement]);

  const stateClass = latest ? `para-${latest.status}` : "para-fresh";
  const playingClass = nowPlaying ? "para-now-playing" : "";
  const paraKey = `s${sectionIdx}-p${paragraphIdx}`;

  return (
    <>
      <div className={`para-cell para-cell-mark ${stateClass} ${playingClass}`}>
        {hasReplacement ? (
          <>
            <div
              className="para-original-strike"
              dangerouslySetInnerHTML={{ __html: originalHtml }}
            />
            <div
              className="para-replacement"
              dangerouslySetInnerHTML={{ __html: replacementHtml }}
            />
          </>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: originalHtml }} />
        )}
      </div>

      <div
        className={`para-cell para-cell-bubble ${stateClass} ${playingClass}`}
        data-para-key={paraKey}
      >
        {/* Mobile-only paragraph text — the document column is hidden at
            narrow widths, so reproduce the text at the top of the bubble so
            the user knows what the narrator is reading before pressing play. */}
        <div
          className="para-mobile-text"
          dangerouslySetInnerHTML={{ __html: originalHtml }}
        />
        <ParaActionStrip
          hasReview={!!latest}
          activeAction={activeAction}
          onAction={onAction}
        />
        {latest && (
          <ReviewBubble review={latest} onUpdated={onReviewUpdated} />
        )}
      </div>
    </>
  );
}

function ReviewBubble({
  review,
  onUpdated,
}: {
  review: ReviewDetail;
  onUpdated: (r: ReviewDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [loadingResponse, setLoadingResponse] = useState(false);
  const [userComment, setUserComment] = useState(review.user_comment ?? "");
  const isPending = review.status === "pending";
  const isAccepted = review.status === "accepted";
  const isRejected = review.status === "rejected";

  // Keep the textarea in sync if the server bumps user_comment (e.g. another
  // tab regenerated). Only do this for the initial value of a given review id
  // so we don't trample the user's in-flight typing.
  useEffect(() => {
    setUserComment(review.user_comment ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.id]);

  const handleGetResponse = async () => {
    setLoadingResponse(true);
    try {
      const updated = await api.stageResponse(
        review.document_id,
        review.section_idx,
        review.paragraph_idx
      );
      onUpdated(updated);
    } finally {
      setLoadingResponse(false);
    }
  };

  const act = async (kind: "accept" | "reject") => {
    // First-time transition out of pending — play the "Noted" response audio
    // afterward. On a regenerate (already accepted), skip the auto-play.
    const isFirstResolve = review.status === "pending";
    setBusy(true);
    try {
      const updated =
        kind === "accept"
          ? await api.acceptReview(review.id, userComment.trim() || undefined)
          : await api.rejectReview(review.id, userComment.trim() || undefined);
      onUpdated(updated);
      if (isFirstResolve) {
        setTimeout(() => {
          const el = document.querySelector<HTMLAudioElement>(
            `audio[data-response-for="${updated.id}"]`
          );
          if (el) {
            el.currentTime = 0;
            el.play();
          }
        }, 100);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`bubble bubble-${review.status}`}>
      <section className="speaker-panel speaker-reviewer">
        <header className="speaker-head">
          <span className="speaker-label">Reviewer</span>
        </header>
        <p className="speaker-text">{review.comment}</p>
        {review.reviewer_audio_url && (
          <audio
            controls
            src={review.reviewer_audio_url}
            preload="none"
          />
        )}
      </section>

      {review.narrator_response_text ? (
        <section className="speaker-panel speaker-narrator narrator-reply">
          <header className="speaker-head">
            <span className="speaker-label">Narrator</span>
            <span className="speaker-note">replying to reviewer</span>
          </header>
          <p className="speaker-text">{review.narrator_response_text}</p>
          {review.response_audio_url && (
            <audio
              data-response-for={review.id}
              controls
              src={review.response_audio_url}
              preload="none"
            />
          )}
        </section>
      ) : (
        <button
          className="primary get-response-btn"
          onClick={handleGetResponse}
          disabled={loadingResponse}
          title="Run the narrator responder agent against the reviewer's critique (uses the same context docs)"
        >
          {loadingResponse ? "Getting response…" : "▶ Get narrator's response"}
        </button>
      )}

      {isPending && (
        <>
          <div className="user-comment">
            <div className="user-comment-head">
              <label htmlFor={`uc-${review.id}`}>Your notes</label>
              <MicNoteButton
                onTranscript={(t) =>
                  setUserComment((c) => (c ? c.trim() + " " : "") + t)
                }
              />
            </div>
            <textarea
              id={`uc-${review.id}`}
              value={userComment}
              placeholder="Optional note to capture alongside this decision"
              onChange={(e) => setUserComment(e.target.value)}
              rows={2}
              disabled={busy}
            />
          </div>
          <div className="bubble-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => act("accept")}
              title="Run the editor agent and mark this paragraph as accepted"
            >
              Apply
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => act("reject")}
            >
              Reject
            </button>
          </div>
        </>
      )}

      {isAccepted && (
        <>
          <div className="user-comment">
            <div className="user-comment-head">
              <label htmlFor={`uc-${review.id}`}>
                Your notes (editable — Regenerate to apply changes)
              </label>
              <MicNoteButton
                onTranscript={(t) =>
                  setUserComment((c) => (c ? c.trim() + " " : "") + t)
                }
              />
            </div>
            <textarea
              id={`uc-${review.id}`}
              value={userComment}
              placeholder="Tell the editor what to adjust on the next rewrite"
              onChange={(e) => setUserComment(e.target.value)}
              rows={3}
              disabled={busy}
            />
          </div>
          <div className="bubble-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => act("accept")}
              title="Re-run the editor with your updated note"
            >
              {busy ? "Regenerating…" : "↻ Regenerate"}
            </button>
            <span className={`status status-${review.status}`}>
              ✓ Accepted
            </span>
          </div>
          {/* Show the response-audio row only when there's no narrator_response_text;
              auto-accept renders the audio inline with the conversational reply above. */}
          {review.response_audio_url && !review.narrator_response_text && (
            <div className="audio-row response-row">
              <label className="audio-label">Narrator reply</label>
              <audio
                data-response-for={review.id}
                controls
                src={review.response_audio_url}
                preload="auto"
              />
            </div>
          )}
        </>
      )}

      {isRejected && (
        <>
          {review.user_comment && (
            <div className="user-comment-saved">
              <span className="label">Your note:</span> {review.user_comment}
            </div>
          )}
          {review.response_audio_url && (
            <div className="audio-row response-row">
              <label className="audio-label">Narrator reply</label>
              <audio
                data-response-for={review.id}
                controls
                src={review.response_audio_url}
                preload="auto"
              />
            </div>
          )}
          <span className={`status status-${review.status}`}>✗ Rejected</span>
        </>
      )}
    </div>
  );
}

interface ParaActionStripProps {
  hasReview: boolean;
  activeAction:
    | { action: ParaAction; state: "loading" | "playing" }
    | null;
  onAction: (action: ParaAction) => void;
}

function ParaActionStrip({
  hasReview,
  activeAction,
  onAction,
}: ParaActionStripProps) {
  const isActive = (a: ParaAction) =>
    activeAction?.action === a;
  const isBusy = activeAction?.state === "loading";

  return (
    <div className="para-action-strip">
      <ActionButton
        title="Narrate — play the narrator audio for this paragraph"
        icon={mdiVolumeHigh}
        active={isActive("narrate")}
        loading={isActive("narrate") && isBusy}
        onClick={() => onAction("narrate")}
      />
      <ActionButton
        title="Review — generate the reviewer agent's commentary + audio"
        icon={mdiCommentTextOutline}
        active={isActive("review")}
        loading={isActive("review") && isBusy}
        onClick={() => onAction("review")}
      />
      <ActionButton
        title="Respond — generate the narrator's conversational reply to the reviewer"
        icon={mdiReplyOutline}
        active={isActive("respond")}
        loading={isActive("respond") && isBusy}
        onClick={() => onAction("respond")}
      />
      <ActionButton
        title={
          hasReview
            ? "Clear — delete every review on this paragraph"
            : "Nothing to clear — no review exists yet"
        }
        icon={mdiTrashCanOutline}
        active={false}
        loading={false}
        disabled={!hasReview}
        onClick={() => onAction("clear")}
      />
    </div>
  );
}

function ActionButton({
  title,
  icon,
  active,
  loading,
  disabled,
  onClick,
}: {
  title: string;
  icon: string;
  active: boolean;
  loading: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`para-action-btn ${active ? "active" : ""} ${loading ? "loading" : ""}`}
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
    >
      <Icon path={loading ? mdiLoading : icon} size={0.9} spin={loading} />
    </button>
  );
}

/** Click-to-toggle voice note button. Click once to start recording, click
 *  again (or hit Stop) to end and transcribe via Whisper. Calls
 *  `onTranscript(text)` with the result so the parent can append it to
 *  whatever textarea state it owns. */
function MicNoteButton({
  onTranscript,
}: {
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "processing">(
    "idle"
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("audio/webm");

  const stopAndCleanup = () => {
    try {
      recorderRef.current?.stop();
    } catch {}
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert(
        "Microphone requires HTTPS or localhost. Use the HTTPS dev URL or Tailscale Serve."
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      mimeRef.current = mime || "audio/webm";
      chunksRef.current = [];
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        setState("processing");
        try {
          const result = await api.transcribe(blob);
          if (result.text) onTranscript(result.text);
        } catch (e) {
          console.error("transcribe failed", e);
        } finally {
          setState("idle");
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch (e) {
      console.error("getUserMedia failed", e);
      setState("idle");
    }
  };

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      try {
        recorderRef.current?.stop();
      } catch {}
    };
  }, []);

  return (
    <button
      type="button"
      className={`mic-note-btn ${state}`}
      onClick={
        state === "recording"
          ? stopAndCleanup
          : state === "processing"
          ? undefined
          : start
      }
      disabled={state === "processing"}
      title={
        state === "recording"
          ? "Stop and transcribe"
          : state === "processing"
          ? "Transcribing…"
          : "Record voice note — transcribed via Whisper"
      }
    >
      <Icon
        path={state === "processing" ? mdiLoading : mdiMicrophone}
        size={0.7}
        spin={state === "processing"}
      />
    </button>
  );
}
