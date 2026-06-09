/**
 * Shared types for the audio player system.
 */

import type { DocumentDetail } from "../api";

// ---- Speed control ----

export const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;
export type SpeedValue = (typeof SPEED_STEPS)[number];

const SPEED_STORAGE_KEY = "doc2meeting_playback_speed";

export function loadSpeed(): SpeedValue {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (SPEED_STEPS.includes(n as SpeedValue)) return n as SpeedValue;
    }
  } catch { /* ignore */ }
  return 1;
}

export function saveSpeed(s: SpeedValue) {
  try {
    localStorage.setItem(SPEED_STORAGE_KEY, String(s));
  } catch { /* ignore */ }
}

// ---- Playback types ----

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "finished";

export interface SectionPlayInfo {
  sectionIdx: number;
  title: string;
  duration: number | null; // seconds, null if unknown
  completed: boolean;
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
}

export type AudioPlayerContextValue = AudioPlayerState & AudioPlayerActions;
