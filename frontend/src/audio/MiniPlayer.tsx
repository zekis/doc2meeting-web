/**
 * Mini-player — collapsed bar at the bottom showing section title,
 * play/pause, and progress. Tap to expand (navigate to player).
 */

import Icon from "@mdi/react";
import { mdiPlay, mdiPause } from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";

interface MiniPlayerProps {
  onExpand: () => void;
}

export function MiniPlayer({ onExpand }: MiniPlayerProps) {
  const {
    doc,
    playbackState,
    currentSectionIdx,
    progress,
    sections,
    togglePlayPause,
  } = useAudioPlayer();

  // Don't show if nothing is loaded or finished
  if (!doc || playbackState === "idle") return null;

  const currentSection = sections.find((s) => s.sectionIdx === currentSectionIdx);
  const sectionTitle = currentSection?.title ?? "Loading...";
  const isPlaying = playbackState === "playing";

  return (
    <div className="mini-player" onClick={onExpand}>
      {/* Progress bar at top */}
      <div className="mini-player-progress">
        <div
          className="mini-player-progress-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="mini-player-content">
        <div className="mini-player-info">
          <span className="mini-player-doc truncate text-xs text-fg-muted">
            {doc.name}
          </span>
          <span className="mini-player-section truncate text-sm font-medium">
            {sectionTitle}
          </span>
        </div>

        <button
          className="mini-player-play-btn"
          onClick={(e) => {
            e.stopPropagation();
            togglePlayPause();
          }}
          title={isPlaying ? "Pause" : "Play"}
        >
          <Icon path={isPlaying ? mdiPause : mdiPlay} size={1} />
        </button>
      </div>
    </div>
  );
}
