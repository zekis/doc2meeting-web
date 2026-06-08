/**
 * Play-all audiobook player with a staged-segment pipeline.
 *
 * Each paragraph plays a sequence of segments — narrator, then (when
 * `withReview` is on) reviewer and the narrator's response. Every segment is
 * a separate backend call; an in-process pump runs ahead of the playhead and
 * prepares the next-needed segment serially. The player blocks on each
 * segment via the same shared promise cache, so it never duplicates work.
 *
 * Pause stops both audio playback and the pump. Resume restarts both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DocumentDetail, ReviewDetail } from "./api";

export interface PlayTarget {
  sectionIdx: number;
  paragraphIdx: number;
}

export type PlayerState = "idle" | "playing" | "paused" | "loading" | "finished";

type SegmentKind = "narrator" | "reviewer" | "response";

interface PlayerOptions {
  withReview: boolean;
  autoAccept: boolean;
  /** When false, the player stops after the current paragraph's segments
   *  finish — it won't roll on to the next paragraph automatically. */
  autoContinue: boolean;
  /** Multiplier applied to the audio element's playbackRate. 1.0 = normal. */
  playbackRate: number;
  /** Called whenever a stage updates a review so DocReview can refresh state. */
  onReviewUpdated: (r: ReviewDetail) => void;
}

export interface PlayerControls {
  state: PlayerState;
  currentIndex: number;     // pointer into `targets`; -1 when not started
  current: PlayTarget | null;
  currentSegment: SegmentKind | null;
  total: number;
  /** Count of paragraphs whose narrator URL is ready. */
  processedCount: number;
  /** Returns the narrator audio URL for one paragraph if TTS has resolved, else null. */
  getNarratorUrl: (sectionIdx: number, paragraphIdx: number) => string | null;
  /** Last user-facing error message, if any. */
  error: string | null;
  play: () => void;
  pause: () => void;
  skipNext: () => void;
  stop: () => void;
}

export function usePlayer(
  doc: DocumentDetail,
  options: PlayerOptions
): PlayerControls {
  const { withReview, autoAccept, autoContinue, playbackRate, onReviewUpdated } = options;

  const targets = useMemo<PlayTarget[]>(() => {
    const out: PlayTarget[] = [];
    for (const s of doc.sections) {
      for (let i = 0; i < s.paragraphs.length; i++) {
        out.push({ sectionIdx: s.idx, paragraphIdx: i });
      }
    }
    return out;
  }, [doc.id, doc.sections.map((s) => `${s.idx}:${s.paragraphs.length}`).join("|")]);

  const [state, setState] = useState<PlayerState>("idle");
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  // Mirror of currentIndex for the pump's lookahead throttle. Read inside
  // an async loop — useState's value would be stale.
  const currentIndexRef = useRef<number>(-1);
  currentIndexRef.current = currentIndex;
  const [currentSegment, setCurrentSegment] = useState<SegmentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [narratorUrls, setNarratorUrls] = useState<Record<string, string>>({});

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Per-paragraph promise caches for each stage. Both the player and the
  // pump look up via these, so neither duplicates the other's in-flight
  // backend call.
  const narratorCache = useRef<Map<number, Promise<string>>>(new Map());
  const reviewerCache = useRef<Map<number, Promise<ReviewDetail>>>(new Map());
  const responseCache = useRef<Map<number, Promise<ReviewDetail>>>(new Map());
  const acceptCache = useRef<Map<number, Promise<ReviewDetail>>>(new Map());

  // Two epoch counters: one for the player chain, one for the pump. Either
  // can be invalidated independently if needed, but pause/stop bumps both.
  const playerEpochRef = useRef(0);
  const pumpEpochRef = useRef(0);

  const stateRef = useRef<PlayerState>("idle");
  stateRef.current = state;
  const segIdxRef = useRef(0);

  const withReviewRef = useRef(withReview);
  withReviewRef.current = withReview;
  const autoAcceptRef = useRef(autoAccept);
  autoAcceptRef.current = autoAccept;
  const autoContinueRef = useRef(autoContinue);
  autoContinueRef.current = autoContinue;
  const onReviewUpdatedRef = useRef(onReviewUpdated);
  onReviewUpdatedRef.current = onReviewUpdated;
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    el.playbackRate = playbackRate;
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep playbackRate in sync as the prop changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // ---- Per-stage ensure helpers. Each is idempotent and cached so both
  // the player and the pump can race-call them safely. ----

  const ensureNarrator = useCallback(
    (paraIdx: number): Promise<string> => {
      const cached = narratorCache.current.get(paraIdx);
      if (cached) return cached;
      const t = targets[paraIdx];
      if (!t) return Promise.reject(new Error("Index out of range"));
      // Reviewer or response stage may have already produced narrator audio
      // and stored it on the review. Use that directly when available.
      const sec = docRef.current.sections.find((s) => s.idx === t.sectionIdx);
      const review = sec?.reviews.find((r) => r.paragraph_idx === t.paragraphIdx);
      if (review?.narrator_audio_url) {
        const p = Promise.resolve(review.narrator_audio_url);
        narratorCache.current.set(paraIdx, p);
        return p;
      }
      const key = `${t.sectionIdx}-${t.paragraphIdx}`;
      const p = api
        .getParagraphNarrator(docRef.current.id, t.sectionIdx, t.paragraphIdx)
        .then((r) => {
          setNarratorUrls((prev) =>
            prev[key] === r.narrator_audio_url
              ? prev
              : { ...prev, [key]: r.narrator_audio_url }
          );
          return r.narrator_audio_url;
        });
      narratorCache.current.set(paraIdx, p);
      return p;
    },
    [targets]
  );

  const ensureReviewer = useCallback(
    (paraIdx: number): Promise<ReviewDetail> => {
      const cached = reviewerCache.current.get(paraIdx);
      if (cached) return cached;
      const t = targets[paraIdx];
      if (!t) return Promise.reject(new Error("Index out of range"));
      // If the doc already has a review with reviewer audio, short-circuit.
      const sec = docRef.current.sections.find((s) => s.idx === t.sectionIdx);
      const review = sec?.reviews.find((r) => r.paragraph_idx === t.paragraphIdx);
      if (review?.comment && review.reviewer_audio_url) {
        const p = Promise.resolve(review);
        reviewerCache.current.set(paraIdx, p);
        return p;
      }
      const p = api
        .stageReviewer(docRef.current.id, t.sectionIdx, t.paragraphIdx)
        .then((r) => {
          onReviewUpdatedRef.current(r);
          return r;
        });
      reviewerCache.current.set(paraIdx, p);
      return p;
    },
    [targets]
  );

  const ensureResponse = useCallback(
    (paraIdx: number): Promise<ReviewDetail> => {
      const cached = responseCache.current.get(paraIdx);
      if (cached) return cached;
      const t = targets[paraIdx];
      if (!t) return Promise.reject(new Error("Index out of range"));
      const sec = docRef.current.sections.find((s) => s.idx === t.sectionIdx);
      const review = sec?.reviews.find((r) => r.paragraph_idx === t.paragraphIdx);
      if (review?.narrator_response_text && review.response_audio_url) {
        const p = Promise.resolve(review);
        responseCache.current.set(paraIdx, p);
        return p;
      }
      // Response endpoint requires the reviewer to exist; serialize via the
      // reviewer cache to make sure that's true before we call.
      const p = ensureReviewer(paraIdx)
        .then(() =>
          api.stageResponse(docRef.current.id, t.sectionIdx, t.paragraphIdx)
        )
        .then((r) => {
          onReviewUpdatedRef.current(r);
          return r;
        });
      responseCache.current.set(paraIdx, p);
      return p;
    },
    [ensureReviewer, targets]
  );

  const ensureAccept = useCallback(
    (paraIdx: number): Promise<ReviewDetail> => {
      const cached = acceptCache.current.get(paraIdx);
      if (cached) return cached;
      const t = targets[paraIdx];
      if (!t) return Promise.reject(new Error("Index out of range"));
      const p = ensureReviewer(paraIdx)
        .then((review) =>
          review.status === "accepted"
            ? review
            : api.acceptReview(review.id)
        )
        .then((r) => {
          onReviewUpdatedRef.current(r);
          return r;
        });
      acceptCache.current.set(paraIdx, p);
      return p;
    },
    [ensureReviewer, targets]
  );

  // ---- Pump: prepare segments ahead of the playhead, one at a time. ----

  // How many paragraphs ahead of the playhead the pump will run-ahead
  // before pausing. Keeps API spend contained on long docs (instead of
  // grinding through the entire document up-front).
  const PUMP_LOOKAHEAD = 3;

  const pump = useCallback(
    async (epoch: number, startParaIdx: number) => {
      for (let paraIdx = startParaIdx; paraIdx < targets.length; paraIdx++) {
        // Throttle: don't go more than PUMP_LOOKAHEAD paragraphs past the
        // playhead. Wakes up once the playhead has advanced (200ms poll).
        while (paraIdx > currentIndexRef.current + PUMP_LOOKAHEAD) {
          if (epoch !== pumpEpochRef.current) return;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (epoch !== pumpEpochRef.current) return;
        try {
          await ensureNarrator(paraIdx);
        } catch {
          /* keep going so a single failure doesn't stall the pipeline */
        }
        if (withReviewRef.current) {
          if (epoch !== pumpEpochRef.current) return;
          try {
            await ensureReviewer(paraIdx);
          } catch {}
          if (epoch !== pumpEpochRef.current) return;
          try {
            await ensureResponse(paraIdx);
          } catch {}
        }
        if (autoAcceptRef.current) {
          if (epoch !== pumpEpochRef.current) return;
          try {
            await ensureAccept(paraIdx);
          } catch {}
        }
      }
    },
    [ensureNarrator, ensureReviewer, ensureResponse, ensureAccept, targets.length]
  );

  // ---- Player chain. Awaits the right ensure for the current segment. ----

  const playSegment = useCallback(
    async (paraIdx: number, segIdx: number) => {
      const epoch = ++playerEpochRef.current;
      if (paraIdx < 0 || paraIdx >= targets.length) {
        setState("finished");
        setCurrentSegment(null);
        return;
      }

      // segment 0: narrator (always)
      // segment 1: reviewer (only when withReview)
      // segment 2: response (only when withReview)
      const hasReview = withReviewRef.current;
      const lastSegIdx = hasReview ? 2 : 0;
      if (segIdx > lastSegIdx) {
        if (!autoContinueRef.current) {
          // Stop after this paragraph's segments. User has to hit play
          // again (or use a per-paragraph icon) to continue.
          setState("paused");
          setCurrentSegment(null);
          return;
        }
        return playSegment(paraIdx + 1, 0);
      }

      setCurrentIndex(paraIdx);
      segIdxRef.current = segIdx;
      const kind: SegmentKind =
        segIdx === 0 ? "narrator" : segIdx === 1 ? "reviewer" : "response";
      setCurrentSegment(kind);
      setState("loading");
      setError(null);

      let url: string | null = null;
      try {
        if (kind === "narrator") {
          url = await ensureNarrator(paraIdx);
        } else if (kind === "reviewer") {
          const review = await ensureReviewer(paraIdx);
          url = review.reviewer_audio_url;
        } else {
          const review = await ensureResponse(paraIdx);
          url = review.response_audio_url;
        }
      } catch (e) {
        if (epoch !== playerEpochRef.current) return;
        setError((e as Error).message);
        setState("paused");
        return;
      }
      if (epoch !== playerEpochRef.current) return;

      if (!url) {
        // Stage ran but produced no audio (e.g. responder errored upstream).
        // Skip this segment and move on rather than stalling.
        return playSegment(paraIdx, segIdx + 1);
      }

      const audio = audioRef.current;
      if (!audio) return;
      audio.onended = null;
      audio.src = url;
      audio.currentTime = 0;
      try {
        await audio.play();
      } catch (e) {
        if (epoch !== playerEpochRef.current) return;
        setError((e as Error).message);
        setState("paused");
        return;
      }
      setState("playing");

      audio.onended = () => {
        if (epoch !== playerEpochRef.current) return;
        playSegment(paraIdx, segIdx + 1);
      };
    },
    [ensureNarrator, ensureReviewer, ensureResponse, targets.length]
  );

  // ---- Public controls ----

  const play = useCallback(() => {
    if (stateRef.current === "playing") return;
    const audio = audioRef.current;
    if (
      stateRef.current === "paused" &&
      audio &&
      audio.src &&
      audio.currentTime > 0 &&
      currentIndex >= 0
    ) {
      playerEpochRef.current++;
      const epoch = playerEpochRef.current;
      const resumeParaIdx = currentIndex;
      const resumeSegIdx = segIdxRef.current;
      audio.onended = () => {
        if (epoch !== playerEpochRef.current) return;
        playSegment(resumeParaIdx, resumeSegIdx + 1);
      };
      audio
        .play()
        .then(() => setState("playing"))
        .catch((e) => {
          setError((e as Error).message);
          setState("paused");
        });
      // Restart the pump too — it stops on pause.
      pump(++pumpEpochRef.current, resumeParaIdx).catch(() => {});
      return;
    }
    const startAt =
      currentIndex >= 0 && currentIndex < targets.length ? currentIndex : 0;
    pump(++pumpEpochRef.current, startAt).catch(() => {});
    playSegment(startAt, 0);
  }, [currentIndex, playSegment, pump, targets.length]);

  const pause = useCallback(() => {
    playerEpochRef.current++;
    pumpEpochRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.pause();
    }
    setState("paused");
  }, []);

  const skipNext = useCallback(() => {
    playerEpochRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.pause();
    }
    playSegment(currentIndex + 1, 0);
  }, [currentIndex, playSegment]);

  const stop = useCallback(() => {
    playerEpochRef.current++;
    pumpEpochRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.pause();
      audio.currentTime = 0;
    }
    narratorCache.current.clear();
    reviewerCache.current.clear();
    responseCache.current.clear();
    acceptCache.current.clear();
    setCurrentIndex(-1);
    setCurrentSegment(null);
    segIdxRef.current = 0;
    setState("idle");
  }, []);

  // Reset when the open document changes.
  useEffect(() => {
    stop();
    setNarratorUrls({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  const current = currentIndex >= 0 ? targets[currentIndex] ?? null : null;

  const getNarratorUrl = useCallback(
    (sectionIdx: number, paragraphIdx: number): string | null =>
      narratorUrls[`${sectionIdx}-${paragraphIdx}`] ?? null,
    [narratorUrls]
  );

  return {
    state,
    currentIndex,
    current,
    currentSegment,
    total: targets.length,
    processedCount: Object.keys(narratorUrls).length,
    getNarratorUrl,
    error,
    play,
    pause,
    skipNext,
    stop,
  };
}
