/**
 * Voice input hook — passive-listening VAD + on-demand capture.
 *
 * Uses a pre-buffer approach: a MediaRecorder runs continuously during the
 * "listening" state so the start of speech is never clipped. When RMS crosses
 * the speech threshold the recorder is already capturing, so the lead-in audio
 * is included in the final blob. When silence is detected, the recorder stops
 * and the full audio (pre-buffer + speech) is handed to the caller.
 *
 * The pre-buffer recorder restarts every PRE_BUFFER_MAX_MS seconds during
 * silence to keep the accumulated audio bounded.
 *
 * The hook owns its mic stream — flipping `enabled` to false releases it.
 */

import { useEffect, useRef, useState } from "react";

export type VoiceInputState =
  | "idle"           // mic not open
  | "starting"       // requesting permission
  | "listening"      // monitoring for voice (pre-buffer recording)
  | "recording"      // user is talking, capturing audio
  | "processing"     // onAudioCaptured running
  | "error";

interface VoiceInputOptions {
  enabled: boolean;
  /** Awaited; while running the hook stays in `processing`. */
  onAudioCaptured: (blob: Blob) => Promise<void>;
  onSpeechStart?: () => void;
  /** Fires when ambient noise crosses the noise threshold (lower than speech).
   *  true = noise started, false = noise ended (after debounce). */
  onNoise?: (isNoisy: boolean) => void;
}

export interface VoiceInputControls {
  state: VoiceInputState;
  error: string | null;
  /** Current input RMS (0..1ish) — handy for a level meter. */
  level: number;
}

// Empirically-tuned for typical desk/laptop mics. The start threshold is
// higher than the silence threshold so the hook hysteresis-resists fluttering.
const SPEECH_START_RMS = 0.02;
const SILENCE_RMS = 0.015;
const NOISE_RMS = 0.01;        // lower than speech — any ambient noise
const NOISE_END_MS = 500;      // noise must drop for this long before "quiet"
const SILENCE_MS = 1500;
const FFT_SIZE = 1024;
const MIN_RECORDING_MS = 400; // ignore micro-pops shorter than this
const PRE_BUFFER_MAX_MS = 10_000; // restart pre-buffer every 10s to bound silence

export function useVoiceInput(opts: VoiceInputOptions): VoiceInputControls {
  const { enabled, onAudioCaptured, onSpeechStart, onNoise } = opts;

  const [state, setState] = useState<VoiceInputState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const stateRef = useRef<VoiceInputState>("idle");
  stateRef.current = state;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onAudioCapturedRef = useRef(onAudioCaptured);
  onAudioCapturedRef.current = onAudioCaptured;
  const onSpeechStartRef = useRef(onSpeechStart);
  onSpeechStartRef.current = onSpeechStart;
  const onNoiseRef = useRef(onNoise);
  onNoiseRef.current = onNoise;

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const mimeRef = useRef("audio/webm");
  const preBufferStartRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }
    startMic();
    return cleanup;
    // We intentionally only re-bind when `enabled` toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  async function startMic() {
    setError(null);
    setState("starting");
    if (!navigator.mediaDevices?.getUserMedia) {
      const hint = window.isSecureContext
        ? "this browser doesn't support the Media Capture API"
        : "microphone requires HTTPS (or localhost). Use Tailscale Serve, or the HTTPS Vite dev server.";
      setError(hint);
      setState("error");
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

      // Determine supported MIME type once
      let mime: string | undefined = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mime)) {
        mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      }
      mimeRef.current = mime ?? "audio/webm";

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser);
      analyserRef.current = analyser;

      setState("listening");
      beginPreBuffer();
      runMonitor();
    } catch (e) {
      setError((e as Error).message || "Microphone access denied");
      setState("error");
    }
  }

  /**
   * Start (or restart) the pre-buffer MediaRecorder. This runs continuously
   * during "listening" so that when speech starts the lead-in is captured.
   */
  function beginPreBuffer() {
    if (!streamRef.current) return;
    // Stop any existing recorder without processing its output
    const old = recorderRef.current;
    if (old && old.state === "recording") {
      old.ondataavailable = () => {};
      old.onstop = () => {};
      old.stop();
    }

    const recorder = mimeRef.current
      ? new MediaRecorder(streamRef.current, { mimeType: mimeRef.current })
      : new MediaRecorder(streamRef.current);
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start();
    preBufferStartRef.current = performance.now();
  }

  function runMonitor() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let silenceStart: number | null = null;
    let speechStartedAt = 0;
    let isNoisy = false;
    let noiseEndStart: number | null = null;

    const tick = () => {
      if (!enabledRef.current || !analyserRef.current) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      setLevel(rms);

      const now = performance.now();

      // Noise detection — fires during ANY state (including processing)
      if (rms > NOISE_RMS) {
        noiseEndStart = null;
        if (!isNoisy) {
          isNoisy = true;
          onNoiseRef.current?.(true);
        }
      } else if (isNoisy) {
        if (noiseEndStart === null) noiseEndStart = now;
        else if (now - noiseEndStart >= NOISE_END_MS) {
          isNoisy = false;
          noiseEndStart = null;
          onNoiseRef.current?.(false);
        }
      }

      const cur = stateRef.current;

      if (cur === "listening") {
        if (rms > SPEECH_START_RMS) {
          // Speech detected — recorder is already running with pre-buffer!
          speechStartedAt = now;
          silenceStart = null;
          setState("recording");
          onSpeechStartRef.current?.();
        } else if (now - preBufferStartRef.current > PRE_BUFFER_MAX_MS) {
          // Restart pre-buffer to bound accumulated silence
          beginPreBuffer();
        }
      } else if (cur === "recording") {
        if (rms > SILENCE_RMS) {
          silenceStart = null;
        } else {
          if (silenceStart === null) silenceStart = now;
          else if (
            now - silenceStart >= SILENCE_MS &&
            now - speechStartedAt >= MIN_RECORDING_MS
          ) {
            finishRecording();
            silenceStart = null;
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  /** Stop the recorder, process the blob, and restart the pre-buffer. */
  function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      if (enabledRef.current) {
        setState("listening");
        beginPreBuffer();
      } else {
        setState("idle");
      }
      return;
    }

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      chunksRef.current = [];
      recorderRef.current = null;

      // Restart pre-buffer IMMEDIATELY so mic is ready for next utterance.
      // This prevents the "first speech missed" bug where getUserMedia latency
      // caused a gap between processing-complete and mic-ready.
      if (enabledRef.current && streamRef.current) {
        beginPreBuffer();
        setState("listening");
      }

      try {
        await onAudioCapturedRef.current(blob);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (!enabledRef.current) {
          // Disabled during processing — clean up pre-buffer we started above
          const rec = recorderRef.current as MediaRecorder | null;
          if (rec && rec.state === "recording") {
            rec.ondataavailable = () => {};
            rec.onstop = () => {};
            rec.stop();
          }
          recorderRef.current = null;
          setState("idle");
        }
      }
    };

    recorder.stop();
  }

  function cleanup() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (recorderRef.current?.state === "recording") {
      try {
        recorderRef.current.ondataavailable = () => {};
        recorderRef.current.onstop = () => {};
        recorderRef.current.stop();
      } catch {}
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current?.state !== "closed") {
      ctxRef.current?.close().catch(() => {});
    }
    ctxRef.current = null;
    analyserRef.current = null;
    setLevel(0);
    setState("idle");
  }

  return { state, error, level };
}
