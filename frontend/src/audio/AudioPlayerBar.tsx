/**
 * Persistent audio player bar — sits at the bottom of the player view.
 *
 * Shows: section title, play/pause, skip ±15s, progress scrubber,
 * speed pill, section list toggle.
 */

import Icon from "@mdi/react";
import {
  mdiPlay,
  mdiPause,
  mdiSkipBackward,
  mdiSkipForward,
  mdiRewind,
  mdiFastForward,
  mdiPlaylistMusic,
  mdiLoading,
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayerBar() {
  const {
    doc,
    playbackState,
    currentSectionIdx,
    progress,
    currentTime,
    duration,
    speed,
    sections,
    togglePlayPause,
    skipForward,
    skipBackward,
    nextSection,
    prevSection,
    cycleSpeed,
    seek,
    toggleSectionList,
  } = useAudioPlayer();

  if (!doc) return null;

  const currentSection = sections.find((s) => s.sectionIdx === currentSectionIdx);
  const sectionTitle = currentSection?.title ?? "Loading...";
  const isPlaying = playbackState === "playing";
  const isLoading = playbackState === "loading";

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    seek(parseFloat(e.target.value));
  };

  const handleScrubClick = (e: React.MouseEvent<HTMLInputElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, fraction)));
  };

  return (
    <div className="audio-player-bar">
      {/* Progress scrubber — full width at top of bar */}
      <div className="audio-player-progress-row">
        <span className="audio-player-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          onChange={handleScrub}
          onClick={handleScrubClick}
          className="audio-player-scrubber"
          style={
            { "--progress": `${progress * 100}%` } as React.CSSProperties
          }
        />
        <span className="audio-player-time">{formatTime(duration)}</span>
      </div>

      {/* Controls row */}
      <div className="audio-player-controls">
        {/* Section title — left */}
        <button
          className="audio-player-section-title"
          onClick={toggleSectionList}
          title="Show section list"
        >
          <Icon path={mdiPlaylistMusic} size={0.7} />
          <span className="truncate">{sectionTitle}</span>
        </button>

        {/* Transport — center */}
        <div className="audio-player-transport">
          <button
            className="audio-player-btn audio-player-btn-sm"
            onClick={prevSection}
            title="Previous paragraph"
          >
            <Icon path={mdiSkipBackward} size={0.8} />
          </button>
          <button
            className="audio-player-btn audio-player-btn-sm"
            onClick={() => skipBackward(15)}
            title="Rewind 15s"
          >
            <Icon path={mdiRewind} size={0.8} />
            <span className="audio-player-skip-label">15</span>
          </button>
          <button
            className={`audio-player-btn audio-player-btn-play ${isLoading ? "loading" : ""}`}
            onClick={togglePlayPause}
            title={isPlaying ? "Pause" : "Play"}
          >
            <Icon path={isLoading ? mdiLoading : isPlaying ? mdiPause : mdiPlay} size={1.3} />
          </button>
          <button
            className="audio-player-btn audio-player-btn-sm"
            onClick={() => skipForward(15)}
            title="Fast-forward 15s"
          >
            <Icon path={mdiFastForward} size={0.8} />
            <span className="audio-player-skip-label">15</span>
          </button>
          <button
            className="audio-player-btn audio-player-btn-sm"
            onClick={nextSection}
            title="Next paragraph"
          >
            <Icon path={mdiSkipForward} size={0.8} />
          </button>
        </div>

        {/* Speed pill — right */}
        <button
          className="audio-player-speed-pill"
          onClick={cycleSpeed}
          title="Cycle playback speed"
        >
          {speed}x
        </button>
      </div>
    </div>
  );
}
