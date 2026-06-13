/**
 * Global audio player context — manages continuous section-to-section playback,
 * speed control, pre-fetching, and MediaSession lock-screen integration.
 *
 * Wraps the app so playback persists when navigating between Library ↔ Player.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, DocumentDetail, SectionDetail } from "../api";

// ---- Speed control ----

const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;
type SpeedValue = (typeof SPEED_STEPS)[number];

const SPEED_STORAGE_KEY = "doc2meeting_playback_speed";

function loadSpeed(): SpeedValue {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (SPEED_STEPS.includes(n as SpeedValue)) return n as SpeedValue;
    }
  } catch { /* ignore */ }
  return 1;
}

function saveSpeed(s: SpeedValue) {
  try {
    localStorage.setItem(SPEED_STORAGE_KEY, String(s));
  } catch { /* ignore */ }
}

// ---- Types ----

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "finished";

export interface SectionPlayInfo {
  sectionIdx: number;
  title: string;
  duration: number | null; // seconds, null if unknown
  completed: boolean;
  paragraphs: string[];
  /** Paragraph indices that already have narrator TTS audio. */
  narratorParagraphs: Set<number>;
}

export interface AudioPlayerState {
  /** The document currently loaded into the player (null when idle). */
  doc: DocumentDetail | null;
  /** Current playback state. */
  playbackState: PlaybackState;
  /** Index of the currently playing section. */
  currentSectionIdx: number;
  /** Current paragraph within the section. */
  currentParagraphIdx: number;
  /** Progress of the current audio segment (0–1). */
  progress: number;
  /** Current time in seconds of the active audio. */
  currentTime: number;
  /** Duration in seconds of the active audio segment. */
  duration: number;
  /** Current playback speed. */
  speed: SpeedValue;
  /** Available speed steps. */
  speedSteps: readonly SpeedValue[];
  /** Section metadata for the section list. */
  sections: SectionPlayInfo[];
  /** Whether the section list panel is open. */
  sectionListOpen: boolean;
  /** Set of completed section indices. */
  completedSections: Set<number>;
}

export interface AudioPlayerActions {
  /** Load a document into the player and optionally start playing. */
  loadDocument: (doc: DocumentDetail, autoPlay?: boolean) => void;
  /** Start or resume playback. */
  play: () => void;
  /** Pause playback. */
  pause: () => void;
  /** Toggle play/pause. */
  togglePlayPause: () => void;
  /** Skip forward by seconds. */
  skipForward: (seconds?: number) => void;
  /** Skip backward by seconds. */
  skipBackward: (seconds?: number) => void;
  /** Jump to a specific section. */
  jumpToSection: (sectionIdx: number) => void;
  /** Jump to a specific paragraph within a section. */
  jumpToParagraph: (sectionIdx: number, paragraphIdx: number) => void;
  /** Go to next section. */
  nextSection: () => void;
  /** Go to previous section. */
  prevSection: () => void;
  /** Cycle playback speed. */
  cycleSpeed: () => void;
  /** Set a specific speed. */
  setSpeed: (speed: SpeedValue) => void;
  /** Seek to a position (0–1). */
  seek: (fraction: number) => void;
  /** Open/close the section list. */
  toggleSectionList: () => void;
  setSectionListOpen: (open: boolean) => void;
  /** Stop playback and unload. */
  stop: () => void;
  /** Update the doc reference (for refreshing section data without reloading). */
  updateDoc: (doc: DocumentDetail) => void;
  /** Update current position without starting playback (used by MeetingPanel). */
  setPosition: (sectionIdx: number, paragraphIdx: number) => void;
  /** Register a callback that intercepts jumpToSection/jumpToParagraph (used by MeetingPanel). */
  setNavigationInterceptor: (cb: ((sectionIdx: number, paragraphIdx: number) => void) | null) => void;
}

type AudioPlayerContextValue = AudioPlayerState & AudioPlayerActions;

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerContext);
  if (!ctx) throw new Error("useAudioPlayer must be inside AudioPlayerProvider");
  return ctx;
}

// ---- Provider ----

interface Props { children: ReactNode }

/** How far ahead (in sections) to pre-fetch narrator audio. */
const PREFETCH_SECTIONS_AHEAD = 1;

export function AudioPlayerProvider({ children }: Props) {
  // ---- Core state ----
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [currentParagraphIdx, setCurrentParagraphIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeedState] = useState<SpeedValue>(loadSpeed);
  const [sectionListOpen, setSectionListOpen] = useState(false);
  const [completedSections, setCompletedSections] = useState<Set<number>>(new Set());

  // Refs for async callbacks
  const docRef = useRef(doc);
  docRef.current = doc;
  const playbackRef = useRef(playbackState);
  playbackRef.current = playbackState;
  const sectionIdxRef = useRef(currentSectionIdx);
  sectionIdxRef.current = currentSectionIdx;
  const paragraphIdxRef = useRef(currentParagraphIdx);
  paragraphIdxRef.current = currentParagraphIdx;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const epochRef = useRef(0);
  const navInterceptorRef = useRef<((sectionIdx: number, paragraphIdx: number) => void) | null>(null);

  // Audio element — single instance, reused across segments
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    el.playbackRate = speed;
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep speed in sync
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // ---- Narrator URL cache ----
  const narratorCacheRef = useRef<Map<string, Promise<string>>>(new Map());

  const ensureNarratorUrl = useCallback(
    (docId: number, sectionIdx: number, paragraphIdx: number): Promise<string> => {
      const key = `${docId}-${sectionIdx}-${paragraphIdx}`;
      const cached = narratorCacheRef.current.get(key);
      if (cached) return cached;

      // Check if the doc already has a narrator URL from a review
      const d = docRef.current;
      if (d && d.id === docId) {
        const sec = d.sections.find((s) => s.idx === sectionIdx);
        const review = sec?.reviews.find((r) => r.paragraph_idx === paragraphIdx);
        if (review?.narrator_audio_url) {
          const p = Promise.resolve(review.narrator_audio_url);
          narratorCacheRef.current.set(key, p);
          return p;
        }
      }

      const p = api
        .getParagraphNarrator(docId, sectionIdx, paragraphIdx)
        .then((r) => r.narrator_audio_url);
      narratorCacheRef.current.set(key, p);
      return p;
    },
    []
  );

  // ---- Pre-fetch logic ----
  const prefetchSection = useCallback(
    (d: DocumentDetail, sectionIdx: number) => {
      const sec = d.sections.find((s) => s.idx === sectionIdx);
      if (!sec) return;
      for (let p = 0; p < sec.paragraphs.length; p++) {
        ensureNarratorUrl(d.id, sectionIdx, p).catch(() => {});
      }
    },
    [ensureNarratorUrl]
  );

  // ---- Progress tracking via timeupdate ----
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onTimeUpdate = () => {
      if (el.duration && isFinite(el.duration)) {
        setCurrentTime(el.currentTime);
        setDuration(el.duration);
        setProgress(el.currentTime / el.duration);
      }
    };

    const onLoadedMetadata = () => {
      if (el.duration && isFinite(el.duration)) {
        setDuration(el.duration);
      }
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, []);

  // ---- Pre-fetch trigger at 50% completion ----
  const prefetchTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (progress < 0.5 || !doc) return;
    const key = `${currentSectionIdx}-${currentParagraphIdx}`;
    if (prefetchTriggeredRef.current === key) return;
    prefetchTriggeredRef.current = key;

    // If this is the last paragraph in the section, prefetch the next section
    const sec = doc.sections.find((s) => s.idx === currentSectionIdx);
    if (sec && currentParagraphIdx >= sec.paragraphs.length - 1) {
      const nextSecIdx = doc.sections.findIndex((s) => s.idx === currentSectionIdx) + 1;
      if (nextSecIdx < doc.sections.length) {
        prefetchSection(doc, doc.sections[nextSecIdx].idx);
      }
    }
  }, [progress, currentSectionIdx, currentParagraphIdx, doc, prefetchSection]);

  // ---- Core playback chain ----

  const playParagraph = useCallback(
    async (d: DocumentDetail, sectionIdx: number, paragraphIdx: number, epoch: number) => {
      const sec = d.sections.find((s) => s.idx === sectionIdx);
      if (!sec) return;

      if (paragraphIdx >= sec.paragraphs.length) {
        // Section complete — mark it and auto-advance
        setCompletedSections((prev) => {
          const next = new Set(prev);
          next.add(sectionIdx);
          return next;
        });

        // Find the next section
        const secListIdx = d.sections.findIndex((s) => s.idx === sectionIdx);
        const nextSec = d.sections[secListIdx + 1];
        if (nextSec) {
          // 0.5s silence gap before next section
          await new Promise((r) => setTimeout(r, 500));
          if (epoch !== epochRef.current) return;

          setCurrentSectionIdx(nextSec.idx);
          setCurrentParagraphIdx(0);
          sectionIdxRef.current = nextSec.idx;
          paragraphIdxRef.current = 0;
          prefetchTriggeredRef.current = null;

          // Pre-fetch the section after next
          const nextNextSec = d.sections[secListIdx + 2];
          if (nextNextSec) prefetchSection(d, nextNextSec.idx);

          updateMediaSession(d, nextSec);
          playParagraph(d, nextSec.idx, 0, epoch);
        } else {
          // All sections done
          setPlaybackState("finished");
          updateMediaSessionState("paused");
        }
        return;
      }

      setCurrentSectionIdx(sectionIdx);
      setCurrentParagraphIdx(paragraphIdx);
      sectionIdxRef.current = sectionIdx;
      paragraphIdxRef.current = paragraphIdx;
      setPlaybackState("loading");

      let url: string;
      try {
        url = await ensureNarratorUrl(d.id, sectionIdx, paragraphIdx);
      } catch {
        if (epoch !== epochRef.current) return;
        // Skip this paragraph on error
        playParagraph(d, sectionIdx, paragraphIdx + 1, epoch);
        return;
      }

      if (epoch !== epochRef.current) return;

      const audio = audioRef.current;
      if (!audio) return;

      audio.onended = null;
      audio.src = url;
      audio.currentTime = 0;
      audio.playbackRate = speedRef.current;

      try {
        await audio.play();
      } catch {
        if (epoch !== epochRef.current) return;
        setPlaybackState("paused");
        return;
      }

      if (epoch !== epochRef.current) return;
      setPlaybackState("playing");
      updateMediaSessionState("playing");

      audio.onended = () => {
        if (epoch !== epochRef.current) return;
        playParagraph(d, sectionIdx, paragraphIdx + 1, epoch);
      };
    },
    [ensureNarratorUrl, prefetchSection]
  );

  // ---- MediaSession helpers ----

  function updateMediaSession(d: DocumentDetail, section: SectionDetail) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: section.title || `Section ${section.idx + 1}`,
      artist: "Doc2Audioz",
      album: d.name,
    });
  }

  function updateMediaSessionState(state: "playing" | "paused" | "none") {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = state;
  }

  // ---- MediaSession action handlers ----
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => actions.play()],
      ["pause", () => actions.pause()],
      ["previoustrack", () => actions.prevSection()],
      ["nexttrack", () => actions.nextSection()],
      ["seekbackward", () => actions.skipBackward(15)],
      ["seekforward", () => actions.skipForward(15)],
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch { /* unsupported action */ }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Actions ----

  const actions: AudioPlayerActions = useMemo(() => ({
    loadDocument: (newDoc: DocumentDetail, autoPlay = true) => {
      // Reset state
      epochRef.current++;
      narratorCacheRef.current.clear();
      prefetchTriggeredRef.current = null;
      setDoc(newDoc);
      docRef.current = newDoc;
      setCurrentSectionIdx(newDoc.sections[0]?.idx ?? 0);
      setCurrentParagraphIdx(0);
      sectionIdxRef.current = newDoc.sections[0]?.idx ?? 0;
      paragraphIdxRef.current = 0;
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      setCompletedSections(new Set());
      setPlaybackState("idle");

      // Pre-fetch first section + next
      if (newDoc.sections.length > 0) {
        prefetchSection(newDoc, newDoc.sections[0].idx);
        if (newDoc.sections.length > 1) {
          prefetchSection(newDoc, newDoc.sections[1].idx);
        }
      }

      if (autoPlay && newDoc.sections.length > 0) {
        const epoch = ++epochRef.current;
        const firstSec = newDoc.sections[0];
        updateMediaSession(newDoc, firstSec);
        playParagraph(newDoc, firstSec.idx, 0, epoch);
      }
    },

    play: () => {
      const d = docRef.current;
      if (!d) return;

      const audio = audioRef.current;
      const state = playbackRef.current;

      if (state === "playing") return;

      // Resume paused audio
      if (
        (state === "paused" || state === "loading") &&
        audio?.src &&
        audio.currentTime > 0
      ) {
        const epoch = ++epochRef.current;
        const resumeSecIdx = sectionIdxRef.current;
        const resumeParaIdx = paragraphIdxRef.current;

        audio.onended = () => {
          if (epoch !== epochRef.current) return;
          playParagraph(d, resumeSecIdx, resumeParaIdx + 1, epoch);
        };

        audio
          .play()
          .then(() => {
            setPlaybackState("playing");
            updateMediaSessionState("playing");
          })
          .catch(() => setPlaybackState("paused"));
        return;
      }

      // Start from current position or beginning
      if (state === "finished") {
        // Restart from beginning
        setCompletedSections(new Set());
        const firstSec = d.sections[0];
        if (firstSec) {
          const epoch = ++epochRef.current;
          updateMediaSession(d, firstSec);
          playParagraph(d, firstSec.idx, 0, epoch);
        }
        return;
      }

      const epoch = ++epochRef.current;
      const sec = d.sections.find((s) => s.idx === sectionIdxRef.current);
      if (sec) {
        updateMediaSession(d, sec);
        playParagraph(d, sec.idx, paragraphIdxRef.current, epoch);
      }
    },

    pause: () => {
      epochRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }
      setPlaybackState("paused");
      updateMediaSessionState("paused");
    },

    togglePlayPause: () => {
      if (playbackRef.current === "playing") {
        actions.pause();
      } else {
        actions.play();
      }
    },

    skipForward: (seconds = 15) => {
      const audio = audioRef.current;
      if (audio && audio.duration) {
        audio.currentTime = Math.min(audio.currentTime + seconds, audio.duration);
      }
    },

    skipBackward: (seconds = 15) => {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = Math.max(audio.currentTime - seconds, 0);
      }
    },

    jumpToSection: (sectionIdx: number) => {
      if (navInterceptorRef.current) {
        navInterceptorRef.current(sectionIdx, 0);
        return;
      }
      const d = docRef.current;
      if (!d) return;
      const sec = d.sections.find((s) => s.idx === sectionIdx);
      if (!sec) return;

      epochRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }

      prefetchTriggeredRef.current = null;
      prefetchSection(d, sectionIdx);

      const epoch = ++epochRef.current;
      setCurrentSectionIdx(sectionIdx);
      setCurrentParagraphIdx(0);
      sectionIdxRef.current = sectionIdx;
      paragraphIdxRef.current = 0;
      setProgress(0);
      setCurrentTime(0);

      updateMediaSession(d, sec);
      playParagraph(d, sectionIdx, 0, epoch);
    },

    jumpToParagraph: (sectionIdx: number, paragraphIdx: number) => {
      if (navInterceptorRef.current) {
        navInterceptorRef.current(sectionIdx, paragraphIdx);
        return;
      }
      const d = docRef.current;
      if (!d) return;
      const sec = d.sections.find((s) => s.idx === sectionIdx);
      if (!sec) return;
      if (paragraphIdx < 0 || paragraphIdx >= sec.paragraphs.length) return;

      epochRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
      }

      prefetchTriggeredRef.current = null;
      prefetchSection(d, sectionIdx);

      const epoch = ++epochRef.current;
      setCurrentSectionIdx(sectionIdx);
      setCurrentParagraphIdx(paragraphIdx);
      sectionIdxRef.current = sectionIdx;
      paragraphIdxRef.current = paragraphIdx;
      setProgress(0);
      setCurrentTime(0);

      updateMediaSession(d, sec);
      playParagraph(d, sectionIdx, paragraphIdx, epoch);
    },

    nextSection: () => {
      const d = docRef.current;
      if (!d) return;
      const secIdx = sectionIdxRef.current;
      const sec = d.sections.find((s) => s.idx === secIdx);
      if (!sec) return;

      const paraIdx = paragraphIdxRef.current;
      // If there are more paragraphs in this section, advance to the next one
      if (paraIdx + 1 < sec.paragraphs.length) {
        epochRef.current++;
        const audio = audioRef.current;
        if (audio) { audio.onended = null; audio.pause(); }
        prefetchTriggeredRef.current = null;
        const epoch = ++epochRef.current;
        const nextPara = paraIdx + 1;
        setCurrentParagraphIdx(nextPara);
        paragraphIdxRef.current = nextPara;
        setProgress(0);
        setCurrentTime(0);
        playParagraph(d, secIdx, nextPara, epoch);
        return;
      }

      // Last paragraph — jump to next section
      const listIdx = d.sections.findIndex((s) => s.idx === secIdx);
      const next = d.sections[listIdx + 1];
      if (next) actions.jumpToSection(next.idx);
    },

    prevSection: () => {
      const d = docRef.current;
      if (!d) return;
      const secIdx = sectionIdxRef.current;
      const paraIdx = paragraphIdxRef.current;

      // If not on the first paragraph, go to previous paragraph
      if (paraIdx > 0) {
        epochRef.current++;
        const audio = audioRef.current;
        if (audio) { audio.onended = null; audio.pause(); }
        prefetchTriggeredRef.current = null;
        const epoch = ++epochRef.current;
        const prevPara = paraIdx - 1;
        setCurrentParagraphIdx(prevPara);
        paragraphIdxRef.current = prevPara;
        setProgress(0);
        setCurrentTime(0);
        playParagraph(d, secIdx, prevPara, epoch);
        return;
      }

      // First paragraph — jump to previous section
      const listIdx = d.sections.findIndex((s) => s.idx === secIdx);
      const prev = d.sections[listIdx - 1];
      if (prev) actions.jumpToSection(prev.idx);
    },

    cycleSpeed: () => {
      setSpeedState((prev) => {
        const idx = SPEED_STEPS.indexOf(prev);
        const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
        saveSpeed(next);
        return next;
      });
    },

    setSpeed: (s: SpeedValue) => {
      if (SPEED_STEPS.includes(s)) {
        setSpeedState(s);
        saveSpeed(s);
      }
    },

    seek: (fraction: number) => {
      const audio = audioRef.current;
      if (audio && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = fraction * audio.duration;
      }
    },

    toggleSectionList: () => setSectionListOpen((prev) => !prev),
    setSectionListOpen,

    stop: () => {
      epochRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
        audio.src = "";
      }
      narratorCacheRef.current.clear();
      setDoc(null);
      docRef.current = null;
      setPlaybackState("idle");
      setCurrentSectionIdx(0);
      setCurrentParagraphIdx(0);
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      setCompletedSections(new Set());
      updateMediaSessionState("none");
    },

    updateDoc: (newDoc: DocumentDetail) => {
      setDoc(newDoc);
      docRef.current = newDoc;
    },

    setPosition: (sectionIdx: number, paragraphIdx: number) => {
      setCurrentSectionIdx(sectionIdx);
      setCurrentParagraphIdx(paragraphIdx);
      sectionIdxRef.current = sectionIdx;
      paragraphIdxRef.current = paragraphIdx;
    },

    setNavigationInterceptor: (cb) => {
      navInterceptorRef.current = cb;
    },
  }), [playParagraph, prefetchSection]);

  // ---- Section play info ----
  const sections: SectionPlayInfo[] = useMemo(() => {
    if (!doc) return [];
    return doc.sections.map((s) => ({
      sectionIdx: s.idx,
      title: s.title || `Section ${s.idx + 1}`,
      duration: null, // We don't know durations until audio loads
      completed: completedSections.has(s.idx),
      paragraphs: s.paragraphs,
      narratorParagraphs: new Set(
        s.reviews
          .filter((r) => r.narrator_audio_url)
          .map((r) => r.paragraph_idx)
      ),
    }));
  }, [doc, completedSections]);

  const value: AudioPlayerContextValue = {
    doc,
    playbackState,
    currentSectionIdx,
    currentParagraphIdx,
    progress,
    currentTime,
    duration,
    speed,
    speedSteps: SPEED_STEPS,
    sections,
    sectionListOpen,
    completedSections,
    ...actions,
  };

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  );
}
