/**
 * Custom hook for browser-native speech-to-text using the Web Speech API.
 * Works in Chrome, Edge, and Safari. Falls back gracefully if unsupported.
 */

import { useCallback, useRef, useState } from "react";

// Extend Window for vendor-prefixed SpeechRecognition
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
}

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export const isSpeechSupported = () => getSpeechRecognition() !== null;

export interface UseSpeechRecognitionReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => void;
  /** Stop recording and return a promise that resolves with the final text. */
  stopListening: () => Promise<string>;
  supported: boolean;
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const finalTranscriptRef = useRef("");
  const interimRef = useRef("");
  const endResolveRef = useRef<((text: string) => void) | null>(null);

  const Ctor = getSpeechRecognition();
  const supported = Ctor !== null;

  const startListening = useCallback(() => {
    if (!Ctor) return;
    // Stop any existing session
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-AU";
    recognitionRef.current = recognition;
    finalTranscriptRef.current = "";
    interimRef.current = "";
    setTranscript("");
    setInterimTranscript("");

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      finalTranscriptRef.current = final;
      interimRef.current = interim;
      setTranscript(final);
      setInterimTranscript(interim);
    };

    recognition.onend = () => {
      setIsListening(false);
      // Resolve the stop promise with best available text
      if (endResolveRef.current) {
        const text = (finalTranscriptRef.current + " " + interimRef.current).trim();
        endResolveRef.current(text);
        endResolveRef.current = null;
      }
    };

    recognition.onerror = (event) => {
      console.warn("SpeechRecognition error:", event.error);
      setIsListening(false);
      if (endResolveRef.current) {
        const text = (finalTranscriptRef.current + " " + interimRef.current).trim();
        endResolveRef.current(text);
        endResolveRef.current = null;
      }
    };

    recognition.start();
    setIsListening(true);
  }, [Ctor]);

  const stopListening = useCallback((): Promise<string> => {
    return new Promise<string>((resolve) => {
      const rec = recognitionRef.current;
      if (!rec) {
        resolve((finalTranscriptRef.current + " " + interimRef.current).trim());
        return;
      }
      // Store the resolve callback for onend to call
      endResolveRef.current = resolve;
      recognitionRef.current = null;
      setIsListening(false);
      try {
        rec.stop(); // triggers onresult (final) then onend
      } catch {
        // If stop fails, resolve immediately
        const text = (finalTranscriptRef.current + " " + interimRef.current).trim();
        endResolveRef.current = null;
        resolve(text);
      }
      // Safety timeout — don't hang forever
      setTimeout(() => {
        if (endResolveRef.current) {
          const text = (finalTranscriptRef.current + " " + interimRef.current).trim();
          endResolveRef.current(text);
          endResolveRef.current = null;
        }
      }, 2000);
    });
  }, []);

  return {
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    supported,
  };
}
