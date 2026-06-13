/**
 * MeetingPanel — virtual meeting UI with AI facilitator.
 *
 * Manages the full meeting lifecycle: start → narration → user speech → AI
 * response → tool action → resume narration. Uses useVoiceInput for VAD-based
 * always-on mic, and a separate Audio element for AI response TTS playback.
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
} from "@mdi/js";
import { useAudioPlayer } from "./AudioPlayerContext";
import { useVoiceInput, type VoiceInputState } from "../useVoiceInput";
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
  const {
    playbackState,
    currentSectionIdx,
    currentParagraphIdx,
    jumpToParagraph,
    jumpToSection,
    pause,
    togglePlayPause,
  } = useAudioPlayer();

  const [meetingState, setMeetingState] = useState<MeetingState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MeetingMessageData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const responseAudioRef = useRef<HTMLAudioElement | null>(null);
  const meetingStateRef = useRef(meetingState);
  meetingStateRef.current = meetingState;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Track current position refs for the voice input callbacks
  const sectionIdxRef = useRef(currentSectionIdx);
  sectionIdxRef.current = currentSectionIdx;
  const paragraphIdxRef = useRef(currentParagraphIdx);
  paragraphIdxRef.current = currentParagraphIdx;

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle tool action from AI response
  const handleToolAction = useCallback((reply: MeetingReply) => {
    switch (reply.tool_action) {
      case "continue":
        // Resume narration at next paragraph — togglePlayPause will advance
        togglePlayPause();
        setMeetingState("listening");
        break;
      case "repeat":
        jumpToParagraph(sectionIdxRef.current, paragraphIdxRef.current);
        setMeetingState("listening");
        break;
      case "go_back": {
        const prevPara = paragraphIdxRef.current - 1;
        if (prevPara >= 0) {
          jumpToParagraph(sectionIdxRef.current, prevPara);
        }
        setMeetingState("listening");
        break;
      }
      case "jump_to_section":
        if (reply.target_section_idx != null) {
          jumpToParagraph(reply.target_section_idx, reply.target_paragraph_idx ?? 0);
        }
        setMeetingState("listening");
        break;
      case "summarize":
      default:
        // No navigation — stay paused, user can say "continue" or speak again
        setMeetingState("listening");
        break;
    }
  }, [jumpToParagraph, togglePlayPause]);

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

  // Pause narration when user starts speaking
  const handleSpeechStart = useCallback(() => {
    if (meetingStateRef.current === "agent_responding") return; // Don't interrupt AI
    pause();
    setMeetingState("user_talking");
  }, [pause]);

  // VAD hook — enabled when meeting is active and AI is not talking
  const voiceInput = useVoiceInput({
    enabled: micEnabled && meetingState !== "agent_responding" && meetingState !== "processing" && meetingState !== "idle" && meetingState !== "ended" && meetingState !== "starting",
    onAudioCaptured: handleAudioCaptured,
    onSpeechStart: handleSpeechStart,
  });

  // Start meeting
  const startMeeting = useCallback(async () => {
    setMeetingState("starting");
    setError(null);
    setMessages([]);

    try {
      const result = await meetingApi.startMeeting(docId);
      setSessionId(result.session_id);

      // Add intro message
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

      // Play intro audio, then start narration
      if (result.intro_audio_url) {
        const audio = new Audio(result.intro_audio_url);
        responseAudioRef.current = audio;
        setMeetingState("agent_responding");

        audio.onended = () => {
          responseAudioRef.current = null;
          setMicEnabled(true);
          // Start narration from the beginning
          jumpToParagraph(0, 0);
          setMeetingState("listening");
        };
        audio.onerror = () => {
          responseAudioRef.current = null;
          setMicEnabled(true);
          jumpToParagraph(0, 0);
          setMeetingState("listening");
        };
        audio.play().catch(() => {
          responseAudioRef.current = null;
          setMicEnabled(true);
          jumpToParagraph(0, 0);
          setMeetingState("listening");
        });
      } else {
        setMicEnabled(true);
        jumpToParagraph(0, 0);
        setMeetingState("listening");
      }
    } catch (e) {
      setError((e as Error).message);
      setMeetingState("idle");
    }
  }, [docId, jumpToParagraph]);

  // End meeting
  const endMeeting = useCallback(async () => {
    // Stop any playing response audio
    if (responseAudioRef.current) {
      responseAudioRef.current.pause();
      responseAudioRef.current = null;
    }
    setMicEnabled(false);
    pause();

    if (sessionId) {
      try {
        await meetingApi.endMeeting(sessionId);
      } catch {
        // ignore
      }
    }
    setMeetingState("ended");
  }, [sessionId, pause]);

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

  // Auto-start meeting when panel opens
  useEffect(() => {
    if (meetingState === "idle") {
      startMeeting();
    }
    // Cleanup on unmount
    return () => {
      if (responseAudioRef.current) {
        responseAudioRef.current.pause();
        responseAudioRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stateLabel = (() => {
    switch (meetingState) {
      case "starting": return "Starting meeting...";
      case "listening": return playbackState === "playing" ? "Listening..." : "Ready";
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
            <button className="icon-btn" onClick={onClose} title="Close">
              <Icon path={mdiClose} size={0.7} />
            </button>
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
