/**
 * MeetingPanel — virtual meeting UI with AI facilitator.
 *
 * Manages the full meeting lifecycle: start → narration → user speech → AI
 * response → tool action → resume narration. Uses useVoiceInput for VAD-based
 * always-on mic. Paragraph narration is played through the meeting's own Audio
 * element (not AudioPlayerContext), while setPosition() keeps the content view
 * highlighting in sync.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiClose,
  mdiDownload,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiPhone,
  mdiPhoneHangup,
  mdiLoading,
  mdiReplay,
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";
import { useVoiceInput } from "../useVoiceInput";
import {
  api,
  meetingApi,
  type MeetingMessageData,
  type MeetingReply,
} from "../api";

export type MeetingState =
  | "idle"
  | "starting"
  | "listening"      // narration playing or waiting for user
  | "user_talking"   // user speaking, narration paused
  | "processing"     // transcribing + waiting for AI
  | "agent_responding" // playing AI response TTS
  | "ended";

interface MeetingPanelProps {
  docId: number;
  docName: string;
  onClose: () => void;
}

export function MeetingPanel({ docId, docName, onClose }: MeetingPanelProps) {
  const { doc, pause, setPosition } = useAudioPlayer();

  const [meetingState, setMeetingState] = useState<MeetingState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MeetingMessageData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [isNarrating, setIsNarrating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const responseAudioRef = useRef<HTMLAudioElement | null>(null);
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const narrationEpochRef = useRef(0);
  const meetingStateRef = useRef(meetingState);
  meetingStateRef.current = meetingState;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const docRef = useRef(doc);
  docRef.current = doc;

  // Track current position — meeting manages its own position
  const sectionIdxRef = useRef(0);
  const paragraphIdxRef = useRef(0);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Stop narration audio
  const stopNarration = useCallback(() => {
    narrationEpochRef.current++;
    if (narrationAudioRef.current) {
      narrationAudioRef.current.onended = null;
      narrationAudioRef.current.onerror = null;
      narrationAudioRef.current.pause();
      narrationAudioRef.current = null;
    }
    setIsNarrating(false);
  }, []);

  // Play narrator audio for a specific paragraph, auto-advancing when done
  const playNarrationRef = useRef<(sectionIdx: number, paragraphIdx: number) => void>(() => {});

  const playNarration = useCallback(async (sectionIdx: number, paragraphIdx: number) => {
    const d = docRef.current;
    if (!d) return;

    // Cancel any in-flight narration fetch
    const epoch = ++narrationEpochRef.current;

    // Find the section
    const sec = d.sections.find(s => s.idx === sectionIdx);
    if (!sec) {
      setIsNarrating(false);
      return;
    }

    // If paragraph is past end of section, advance to next section
    if (paragraphIdx >= sec.paragraphs.length) {
      const listIdx = d.sections.findIndex(s => s.idx === sectionIdx);
      const nextSec = d.sections[listIdx + 1];
      if (nextSec) {
        playNarrationRef.current(nextSec.idx, 0);
      } else {
        setIsNarrating(false);
      }
      return;
    }

    // Update position
    sectionIdxRef.current = sectionIdx;
    paragraphIdxRef.current = paragraphIdx;
    setPosition(sectionIdx, paragraphIdx);
    setIsNarrating(true);

    try {
      const { narrator_audio_url } = await api.getParagraphNarrator(d.id, sectionIdx, paragraphIdx);

      // Check if cancelled while fetching
      if (epoch !== narrationEpochRef.current) return;

      const audio = new Audio(narrator_audio_url);
      narrationAudioRef.current = audio;

      audio.onended = () => {
        narrationAudioRef.current = null;
        playNarrationRef.current(sectionIdx, paragraphIdx + 1);
      };
      audio.onerror = () => {
        narrationAudioRef.current = null;
        playNarrationRef.current(sectionIdx, paragraphIdx + 1);
      };
      audio.play().catch(() => {
        narrationAudioRef.current = null;
        playNarrationRef.current(sectionIdx, paragraphIdx + 1);
      });
    } catch {
      if (epoch !== narrationEpochRef.current) return;
      narrationAudioRef.current = null;
      playNarrationRef.current(sectionIdx, paragraphIdx + 1);
    }
  }, [setPosition]);

  playNarrationRef.current = playNarration;

  // Handle tool action from AI response
  const handleToolAction = useCallback((reply: MeetingReply) => {
    switch (reply.tool_action) {
      case "continue": {
        const nextPara = paragraphIdxRef.current + 1;
        setMeetingState("listening");
        playNarrationRef.current(sectionIdxRef.current, nextPara);
        break;
      }
      case "repeat":
        setMeetingState("listening");
        playNarrationRef.current(sectionIdxRef.current, paragraphIdxRef.current);
        break;
      case "go_back": {
        const prevPara = Math.max(0, paragraphIdxRef.current - 1);
        setMeetingState("listening");
        playNarrationRef.current(sectionIdxRef.current, prevPara);
        break;
      }
      case "jump_to_section":
        setMeetingState("listening");
        if (reply.target_section_idx != null) {
          playNarrationRef.current(reply.target_section_idx, reply.target_paragraph_idx ?? 0);
        }
        break;
      case "summarize":
      default:
        // No navigation — stay paused, user can say "continue" or speak again
        setMeetingState("listening");
        break;
    }
  }, []);

  // Play AI response audio, then handle tool action
  const playResponseAudio = useCallback((audioUrl: string, reply: MeetingReply) => {
    const audio = new Audio(audioUrl);
    responseAudioRef.current = audio;
    setMeetingState("agent_responding");

    audio.onended = () => {
      responseAudioRef.current = null;
      handleToolAction(reply);
    };
    audio.onerror = () => {
      responseAudioRef.current = null;
      handleToolAction(reply);
    };
    audio.play().catch(() => {
      responseAudioRef.current = null;
      handleToolAction(reply);
    });
  }, [handleToolAction]);

  // Process captured audio from VAD
  const handleAudioCaptured = useCallback(async (blob: Blob) => {
    if (!sessionIdRef.current) return;
    setMeetingState("processing");

    try {
      // Transcribe via Whisper
      const { text } = await api.transcribe(blob);
      if (!text.trim()) {
        setMeetingState("listening");
        return;
      }

      // Add user message locally
      const userMsg: MeetingMessageData = {
        id: Date.now(),
        role: "user",
        content: text.trim(),
        section_idx: sectionIdxRef.current,
        paragraph_idx: paragraphIdxRef.current,
        tool_action: null,
        audio_url: null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, userMsg]);

      // Send to meeting agent
      const reply = await meetingApi.sendMessage(
        sessionIdRef.current!,
        text.trim(),
        sectionIdxRef.current,
        paragraphIdxRef.current,
      );

      // Add assistant message
      const assistantMsg: MeetingMessageData = {
        id: Date.now() + 1,
        role: "assistant",
        content: reply.reply,
        section_idx: sectionIdxRef.current,
        paragraph_idx: paragraphIdxRef.current,
        tool_action: reply.tool_action,
        audio_url: reply.audio_url,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMsg]);

      // Play response audio
      if (reply.audio_url) {
        playResponseAudio(reply.audio_url, reply);
      } else {
        handleToolAction(reply);
      }
    } catch (e) {
      setError((e as Error).message);
      setMeetingState("listening");
    }
  }, [playResponseAudio, handleToolAction]);

  // Stop all audio when user starts speaking — user can always interrupt
  const handleSpeechStart = useCallback(() => {
    stopNarration();
    if (responseAudioRef.current) {
      responseAudioRef.current.onended = null;
      responseAudioRef.current.onerror = null;
      responseAudioRef.current.pause();
      responseAudioRef.current = null;
    }
    setMeetingState("user_talking");
  }, [stopNarration]);

  // VAD hook — enabled when meeting is active (user can always interrupt)
  const voiceInput = useVoiceInput({
    enabled: micEnabled && meetingState !== "processing" && meetingState !== "idle" && meetingState !== "ended" && meetingState !== "starting",
    onAudioCaptured: handleAudioCaptured,
    onSpeechStart: handleSpeechStart,
  });

  // Play a greeting audio then enable mic + start narration at given position
  const playGreetingThenNarrate = useCallback((
    audioUrl: string | null,
    sectionIdx: number,
    paragraphIdx: number,
  ) => {
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      responseAudioRef.current = audio;
      setMeetingState("agent_responding");

      const begin = () => {
        responseAudioRef.current = null;
        setMicEnabled(true);
        setMeetingState("listening");
        playNarrationRef.current(sectionIdx, paragraphIdx);
      };

      audio.onended = begin;
      audio.onerror = begin;
      audio.play().catch(begin);
    } else {
      setMicEnabled(true);
      setMeetingState("listening");
      playNarrationRef.current(sectionIdx, paragraphIdx);
    }
  }, []);

  // Start a brand new meeting
  const startMeeting = useCallback(async () => {
    setMeetingState("starting");
    setError(null);
    setMessages([]);
    pause();

    try {
      const result = await meetingApi.startMeeting(docId);
      setSessionId(result.session_id);

      const introMsg: MeetingMessageData = {
        id: Date.now(),
        role: "assistant",
        content: result.intro_message,
        section_idx: 0,
        paragraph_idx: 0,
        tool_action: null,
        audio_url: result.intro_audio_url,
        created_at: new Date().toISOString(),
      };
      setMessages([introMsg]);

      playGreetingThenNarrate(result.intro_audio_url, 0, 0);
    } catch (e) {
      setError((e as Error).message);
      setMeetingState("idle");
    }
  }, [docId, pause, playGreetingThenNarrate]);

  // Resume an existing meeting session
  const resumeMeeting = useCallback(async (existingSessionId: string) => {
    setMeetingState("starting");
    setError(null);
    pause();

    try {
      // Load previous messages
      const notes = await meetingApi.getMeetingNotes(existingSessionId);
      setMessages(notes.filter(m => m.role !== "system"));

      // Resume session on backend
      const result = await meetingApi.resumeMeeting(existingSessionId);
      setSessionId(result.session_id);

      // Add welcome-back message
      const resumeMsg: MeetingMessageData = {
        id: Date.now(),
        role: "assistant",
        content: result.resume_message,
        section_idx: result.current_section_idx,
        paragraph_idx: result.current_paragraph_idx,
        tool_action: null,
        audio_url: result.resume_audio_url,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, resumeMsg]);

      // Set position to where we left off
      sectionIdxRef.current = result.current_section_idx;
      paragraphIdxRef.current = result.current_paragraph_idx;

      playGreetingThenNarrate(
        result.resume_audio_url,
        result.current_section_idx,
        result.current_paragraph_idx,
      );
    } catch (e) {
      setError((e as Error).message);
      setMeetingState("idle");
    }
  }, [pause, playGreetingThenNarrate]);

  // Initialize meeting — resume existing or start new
  const initMeeting = useCallback(async () => {
    try {
      const { session } = await meetingApi.getLatestSession(docId);
      if (session) {
        await resumeMeeting(session.id);
      } else {
        await startMeeting();
      }
    } catch {
      // Fallback to new meeting if latest check fails
      await startMeeting();
    }
  }, [docId, resumeMeeting, startMeeting]);

  // End meeting
  const endMeeting = useCallback(async () => {
    stopNarration();
    if (responseAudioRef.current) {
      responseAudioRef.current.pause();
      responseAudioRef.current = null;
    }
    setMicEnabled(false);

    if (sessionId) {
      try {
        await meetingApi.endMeeting(sessionId);
      } catch {
        // ignore
      }
    }
    setMeetingState("ended");
  }, [sessionId, stopNarration]);

  // Export notes
  const handleExport = useCallback(async () => {
    if (!sessionId) return;
    try {
      const md = await meetingApi.exportMeetingNotes(sessionId);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${docName.replace(/\.[^.]+$/, "")}-meeting-notes.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, [sessionId, docName]);

  // Auto-start meeting when panel opens — resume existing or start new
  useEffect(() => {
    if (meetingState === "idle") {
      initMeeting();
    }
    // Cleanup on unmount
    return () => {
      stopNarration();
      if (responseAudioRef.current) {
        responseAudioRef.current.pause();
        responseAudioRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stateLabel = (() => {
    switch (meetingState) {
      case "starting": return "Starting meeting...";
      case "listening": return isNarrating ? "Listening..." : "Ready";
      case "user_talking": return "You're speaking...";
      case "processing": return "Thinking...";
      case "agent_responding": return "Doc is responding...";
      case "ended": return "Meeting ended";
      default: return "";
    }
  })();

  return (
    <div className="meeting-panel">
      {/* Header */}
      <div className="meeting-panel-header">
        <div className="meeting-panel-title">
          <Icon path={mdiPhone} size={0.7} />
          <span className="truncate">Meeting</span>
        </div>
        <div className="meeting-panel-actions">
          {sessionId && messages.length > 0 && (
            <button className="icon-btn" onClick={handleExport} title="Export notes">
              <Icon path={mdiDownload} size={0.7} />
            </button>
          )}
          {meetingState !== "ended" && meetingState !== "idle" && (
            <button className="meeting-end-btn" onClick={endMeeting} title="End meeting">
              <Icon path={mdiPhoneHangup} size={0.7} />
            </button>
          )}
          {meetingState === "ended" && (
            <>
              <button className="icon-btn" onClick={() => resumeMeeting(sessionId!)} title="Resume meeting">
                <Icon path={mdiReplay} size={0.7} />
              </button>
              <button className="icon-btn" onClick={onClose} title="Close">
                <Icon path={mdiClose} size={0.7} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="meeting-panel-messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`meeting-msg meeting-msg-${msg.role}`}
          >
            <div className="meeting-msg-label">
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Doc" : ""}
            </div>
            <div className="meeting-msg-content">{msg.content}</div>
          </div>
        ))}
        {meetingState === "processing" && (
          <div className="meeting-msg meeting-msg-assistant">
            <div className="meeting-msg-label">Doc</div>
            <div className="meeting-msg-content meeting-thinking">
              <Icon path={mdiLoading} size={0.6} spin />
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Status bar */}
      <div className="meeting-panel-status">
        {error && (
          <div className="meeting-error">{error}</div>
        )}
        <div className="meeting-status-row">
          <div className="meeting-mic-indicator">
            <Icon
              path={micEnabled && voiceInput.state !== "error" ? mdiMicrophone : mdiMicrophoneOff}
              size={0.7}
              className={`meeting-mic-icon ${meetingState === "user_talking" ? "active" : ""}`}
            />
            {micEnabled && voiceInput.state !== "error" && (
              <div
                className="meeting-mic-level"
                style={{ width: `${Math.min(voiceInput.level * 300, 100)}%` }}
              />
            )}
          </div>
          <span className="meeting-status-text">{stateLabel}</span>
        </div>
        {voiceInput.error && (
          <div className="meeting-error text-xs">{voiceInput.error}</div>
        )}
      </div>
    </div>
  );
}
