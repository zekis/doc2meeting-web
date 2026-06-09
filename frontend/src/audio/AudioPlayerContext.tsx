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
import {
  SPEED_STEPS,
  loadSpeed,
  saveSpeed,
  type AudioPlayerActions,
  type AudioPlayerContextValue,
  type PlaybackState,
  type SectionPlayInfo,
  type SpeedValue,
} from "./types";

// Re-export types for consumers that import from this file
export type { AudioPlayerContextValue, AudioPlayerActions, PlaybackState, SectionPlayInfo, SpeedValue };
export { SPEED_STEPS };

const AudioPlayerCtx = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerCtx);
  if (!ctx) throw new Error("useAudioPlayer must be inside AudioPlayerProvider");
  return ctx;
}

// ---- Provider ----

interface Props { children: ReactNode }

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

  // Audio element — single instance, reused across segments
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    el.playbackRate = speed;
    audioRef.current = el;
    return () => { el.pause(); el.src = ""; audioRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed]);

  // ---- Narrator URL cache ----
  const narratorCacheRef = useRef<Map<string, Promise<string>>>(new Map());

  const ensureNarratorUrl = useCallback(
    (docId: number, sectionIdx: number, paragraphIdx: number): Promise<string> => {
      const key = `${docId}-${sectionIdx}-${paragraphIdx}`;
      const cached = narratorCacheRef.current.get(key);
      if (cached) return cached;

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

      const p = api.getParagraphNarrator(docId, sectionIdx, paragraphIdx).then((r) => r.narrator_audio_url);
      narratorCacheRef.current.set(key, p);
      return p;
    },
    []
  );

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

  // ---- Progress tracking ----
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => { if (el.duration && isFinite(el.duration)) { setCurrentTime(el.currentTime); setDuration(el.duration); setProgress(el.currentTime / el.duration); } };
    const onMeta = () => { if (el.duration && isFinite(el.duration)) setDuration(el.duration); };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    return () => { el.removeEventListener("timeupdate", onTime); el.removeEventListener("loadedmetadata", onMeta); };
  }, []);

  // ---- Pre-fetch trigger at 50% ----
  const prefetchTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (progress < 0.5 || !doc) return;
    const key = `${currentSectionIdx}-${currentParagraphIdx}`;
    if (prefetchTriggeredRef.current === key) return;
    prefetchTriggeredRef.current = key;
    const sec = doc.sections.find((s) => s.idx === currentSectionIdx);
    if (sec && currentParagraphIdx >= sec.paragraphs.length - 1) {
      const nextSecIdx = doc.sections.findIndex((s) => s.idx === currentSectionIdx) + 1;
      if (nextSecIdx < doc.sections.length) prefetchSection(doc, doc.sections[nextSecIdx].idx);
    }
  }, [progress, currentSectionIdx, currentParagraphIdx, doc, prefetchSection]);

  // ---- MediaSession helpers ----
  function updateMediaSession(d: DocumentDetail, section: SectionDetail) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: section.title || `Section ${section.idx + 1}`, artist: "doc2meeting", album: d.name });
  }
  function updateMediaSessionState(state: "playing" | "paused" | "none") {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = state;
  }

  // ---- Core playback chain ----
  const playParagraph = useCallback(
    async (d: DocumentDetail, sectionIdx: number, paragraphIdx: number, epoch: number) => {
      const sec = d.sections.find((s) => s.idx === sectionIdx);
      if (!sec) return;

      if (paragraphIdx >= sec.paragraphs.length) {
        setCompletedSections((prev) => { const next = new Set(prev); next.add(sectionIdx); return next; });
        const secListIdx = d.sections.findIndex((s) => s.idx === sectionIdx);
        const nextSec = d.sections[secListIdx + 1];
        if (nextSec) {
          await new Promise((r) => setTimeout(r, 500));
          if (epoch !== epochRef.current) return;
          setCurrentSectionIdx(nextSec.idx); setCurrentParagraphIdx(0);
          sectionIdxRef.current = nextSec.idx; paragraphIdxRef.current = 0;
          prefetchTriggeredRef.current = null;
          const nextNextSec = d.sections[secListIdx + 2];
          if (nextNextSec) prefetchSection(d, nextNextSec.idx);
          updateMediaSession(d, nextSec);
          playParagraph(d, nextSec.idx, 0, epoch);
        } else {
          setPlaybackState("finished"); updateMediaSessionState("paused");
        }
        return;
      }

      setCurrentSectionIdx(sectionIdx); setCurrentParagraphIdx(paragraphIdx);
      sectionIdxRef.current = sectionIdx; paragraphIdxRef.current = paragraphIdx;
      setPlaybackState("loading");

      let url: string;
      try { url = await ensureNarratorUrl(d.id, sectionIdx, paragraphIdx); }
      catch { if (epoch !== epochRef.current) return; playParagraph(d, sectionIdx, paragraphIdx + 1, epoch); return; }
      if (epoch !== epochRef.current) return;

      const audio = audioRef.current;
      if (!audio) return;
      audio.onended = null; audio.src = url; audio.currentTime = 0; audio.playbackRate = speedRef.current;
      try { await audio.play(); } catch { if (epoch !== epochRef.current) return; setPlaybackState("paused"); return; }
      if (epoch !== epochRef.current) return;
      setPlaybackState("playing"); updateMediaSessionState("playing");
      audio.onended = () => { if (epoch !== epochRef.current) return; playParagraph(d, sectionIdx, paragraphIdx + 1, epoch); };
    },
    [ensureNarratorUrl, prefetchSection]
  );

  // ---- MediaSession action handlers ----
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => actions.play()], ["pause", () => actions.pause()],
      ["previoustrack", () => actions.prevSection()], ["nexttrack", () => actions.nextSection()],
      ["seekbackward", () => actions.skipBackward(15)], ["seekforward", () => actions.skipForward(15)],
    ];
    for (const [action, handler] of handlers) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ } }
    return () => { for (const [action] of handlers) { try { navigator.mediaSession.setActionHandler(action, null); } catch { /* ignore */ } } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Actions ----
  const actions: AudioPlayerActions = useMemo(() => ({
    loadDocument: (newDoc: DocumentDetail, autoPlay = true) => {
      epochRef.current++; narratorCacheRef.current.clear(); prefetchTriggeredRef.current = null;
      setDoc(newDoc); docRef.current = newDoc;
      setCurrentSectionIdx(newDoc.sections[0]?.idx ?? 0); setCurrentParagraphIdx(0);
      sectionIdxRef.current = newDoc.sections[0]?.idx ?? 0; paragraphIdxRef.current = 0;
      setProgress(0); setCurrentTime(0); setDuration(0); setCompletedSections(new Set()); setPlaybackState("idle");
      if (newDoc.sections.length > 0) { prefetchSection(newDoc, newDoc.sections[0].idx); if (newDoc.sections.length > 1) prefetchSection(newDoc, newDoc.sections[1].idx); }
      if (autoPlay && newDoc.sections.length > 0) { const epoch = ++epochRef.current; const firstSec = newDoc.sections[0]; updateMediaSession(newDoc, firstSec); playParagraph(newDoc, firstSec.idx, 0, epoch); }
    },
    play: () => {
      const d = docRef.current; if (!d) return;
      const audio = audioRef.current; const state = playbackRef.current;
      if (state === "playing") return;
      if ((state === "paused" || state === "loading") && audio?.src && audio.currentTime > 0) {
        const epoch = ++epochRef.current; const rS = sectionIdxRef.current; const rP = paragraphIdxRef.current;
        audio.onended = () => { if (epoch !== epochRef.current) return; playParagraph(d, rS, rP + 1, epoch); };
        audio.play().then(() => { setPlaybackState("playing"); updateMediaSessionState("playing"); }).catch(() => setPlaybackState("paused"));
        return;
      }
      if (state === "finished") { setCompletedSections(new Set()); const fs = d.sections[0]; if (fs) { const epoch = ++epochRef.current; updateMediaSession(d, fs); playParagraph(d, fs.idx, 0, epoch); } return; }
      const epoch = ++epochRef.current; const sec = d.sections.find((s) => s.idx === sectionIdxRef.current);
      if (sec) { updateMediaSession(d, sec); playParagraph(d, sec.idx, paragraphIdxRef.current, epoch); }
    },
    pause: () => { epochRef.current++; const audio = audioRef.current; if (audio) { audio.onended = null; audio.pause(); } setPlaybackState("paused"); updateMediaSessionState("paused"); },
    togglePlayPause: () => { if (playbackRef.current === "playing") actions.pause(); else actions.play(); },
    skipForward: (seconds = 15) => { const a = audioRef.current; if (a && a.duration) a.currentTime = Math.min(a.currentTime + seconds, a.duration); },
    skipBackward: (seconds = 15) => { const a = audioRef.current; if (a) a.currentTime = Math.max(a.currentTime - seconds, 0); },
    jumpToSection: (sectionIdx: number) => {
      const d = docRef.current; if (!d) return; const sec = d.sections.find((s) => s.idx === sectionIdx); if (!sec) return;
      epochRef.current++; const audio = audioRef.current; if (audio) { audio.onended = null; audio.pause(); }
      prefetchTriggeredRef.current = null; prefetchSection(d, sectionIdx);
      const epoch = ++epochRef.current; setCurrentSectionIdx(sectionIdx); setCurrentParagraphIdx(0);
      sectionIdxRef.current = sectionIdx; paragraphIdxRef.current = 0; setProgress(0); setCurrentTime(0);
      updateMediaSession(d, sec); playParagraph(d, sectionIdx, 0, epoch);
    },
    nextSection: () => { const d = docRef.current; if (!d) return; const idx = d.sections.findIndex((s) => s.idx === sectionIdxRef.current); const n = d.sections[idx + 1]; if (n) actions.jumpToSection(n.idx); },
    prevSection: () => { const d = docRef.current; if (!d) return; const idx = d.sections.findIndex((s) => s.idx === sectionIdxRef.current); const p = d.sections[idx - 1]; if (p) actions.jumpToSection(p.idx); },
    cycleSpeed: () => { setSpeedState((prev) => { const idx = SPEED_STEPS.indexOf(prev); const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length]; saveSpeed(next); return next; }); },
    setSpeed: (s: SpeedValue) => { if (SPEED_STEPS.includes(s)) { setSpeedState(s); saveSpeed(s); } },
    seek: (fraction: number) => { const a = audioRef.current; if (a && a.duration && isFinite(a.duration)) a.currentTime = fraction * a.duration; },
    toggleSectionList: () => setSectionListOpen((prev) => !prev),
    setSectionListOpen,
    stop: () => {
      epochRef.current++; const audio = audioRef.current; if (audio) { audio.onended = null; audio.pause(); audio.src = ""; }
      narratorCacheRef.current.clear(); setDoc(null); docRef.current = null; setPlaybackState("idle");
      setCurrentSectionIdx(0); setCurrentParagraphIdx(0); setProgress(0); setCurrentTime(0); setDuration(0);
      setCompletedSections(new Set()); updateMediaSessionState("none");
    },
    updateDoc: (newDoc: DocumentDetail) => { setDoc(newDoc); docRef.current = newDoc; },
  }), [playParagraph, prefetchSection]);

  const sections: SectionPlayInfo[] = useMemo(() => {
    if (!doc) return [];
    return doc.sections.map((s) => ({ sectionIdx: s.idx, title: s.title || `Section ${s.idx + 1}`, duration: null, completed: completedSections.has(s.idx) }));
  }, [doc, completedSections]);

  const value: AudioPlayerContextValue = { doc, playbackState, currentSectionIdx, currentParagraphIdx, progress, currentTime, duration, speed, speedSteps: SPEED_STEPS, sections, sectionListOpen, completedSections, ...actions };

  return <AudioPlayerCtx.Provider value={value}>{children}</AudioPlayerCtx.Provider>;
}
