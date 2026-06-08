/**
 * Voice input hook — passive-listening VAD + on-demand capture.
 *
 * Behaviour:
 *   1. When `enabled` flips true, request mic permission and start an RMS
 *      monitor on the audio stream.
 *   2. When RMS crosses the start threshold, fire onSpeechStart and begin
 *      MediaRecorder capture.
 *   3. When RMS stays below the silence threshold for SILENCE_MS, stop the
 *      recorder.
 *   4. Hand the resulting Blob to the caller via onAudioCaptured (awaited).
 *      Caller is responsible for transcription + any side effects.
 *   5. Return to listening (or idle, if disabled mid-capture).
 *
 * The hook owns its mic stream — flipping `enabled` to false releases it.
 */

import { useEffect, useRef, useState } from "react";

export type VoiceInputState =
  | "idle"           // mic not open
  | "starting"       // requesting permission
  | "listening"      // monitoring for voice
  | "recording"      // user is talking, capturing audio
  | "processing"     // onAudioCaptured running
  | "error";

interface VoiceInputOptions {
  enabled: boolean;
  /** Awaited; while running the hook stays in `processing`. */
  onAudioCaptured: (blob: Blob) => Promise<void>;
  onSpeechStart?: () => void;
}

export interface VoiceInputControls {
  state: VoiceInputState;
  error: string | null;
  /** Current input RMS (0..1ish) — handy for a level meter. */
  level: number;
}

// Empirically-tuned for typical desk mics. The start threshold is higher than
// the silence threshold so the hook hysteresis-resists fluttering on the edge.
const SPEECH_START_RMS = 0.04;
const SILENCE_RMS = 0.015;
const SILENCE_MS = 1500;
const FFT_SIZE = 1024;
const MIN_RECORDING_MS = 400; // ignore micro-pops shorter than this

export function useVoiceInput(opts: VoiceInputOptions): VoiceInputControls {
  const { enabled, onAudioCaptured, onSpeechStart } = opts;

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

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }
    start();
    return cleanup;
    // We intentionally only re-bind when `enabled` toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  async function start() {
    setError(null);
    setState("starting");
    if (!navigator.mediaDevices?.getUserMedia) {
      // The Media Capture API is gated behind secure contexts. Over plain
      // HTTP to a non-localhost host (e.g. a Tailscale IP) the browser
      // doesn't expose `navigator.mediaDevices` at all.
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
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser);
      analyserRef.current = analyser;
      setState("listening");
      runMonitor();
    } catch (e) {
      setError((e as Error).message || "Microphone access denied");
      setState("error");
    }
  }

  function runMonitor() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let silenceStart: number | null = null;
    let recordingStartedAt = 0;

    const tick = () => {
      if (!enabledRef.current || !analyserRef.current) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      setLevel(rms);

      const now = performance.now();
      const cur = stateRef.current;

      if (cur === "listening" && rms > SPEECH_START_RMS) {
        recordingStartedAt = now;
        silenceStart = null;
        beginRecording();
      } else if (cur === "recording") {
        if (rms > SILENCE_RMS) {
          silenceStart = null;
        } else {
          if (silenceStart === null) silenceStart = now;
          else if (
            now - silenceStart >= SILENCE_MS &&
            now - recordingStartedAt >= MIN_RECORDING_MS
          ) {
            endRecording();
            silenceStart = null;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  function beginRecording() {
    if (!streamRef.current) return;
    if (recorderRef.current?.state === "recording") return;
    let mime: string | undefined = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
    }
    const recorder = mime
      ? new MediaRecorder(streamRef.current, { mimeType: mime })
      : new MediaRecorder(streamRef.current);
    recorderRef.current = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mime ?? "audio/webm" });
      setState("processing");
      try {
        await onAudioCapturedRef.current(blob);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        // Resume listening only if the user hasn't disabled us mid-process.
        if (enabledRef.current) setState("listening");
        else setState("idle");
      }
    };
    recorder.start();
    setState("recording");
    onSpeechStartRef.current?.();
  }

  function endRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }

  function cleanup() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (recorderRef.current?.state === "recording") {
      try {
        recorderRef.current.stop();
      } catch {}
    }
    recorderRef.current = null;
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
