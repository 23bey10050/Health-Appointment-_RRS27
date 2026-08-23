import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBaseUrl, apiFetch } from "@/lib/api";

export type AgentState = "connecting" | "thinking" | "listening" | "speaking" | "emergency" | "closed";

export interface EmergencyInfo {
  severity: string;
  category: string;
  numbers: string[];
}

export interface BookingInfo {
  appointmentId: string;
  payload: Record<string, unknown>;
}

export interface VoiceError {
  code: string;
  recoverable: boolean;
  message: string;
}

export interface TranscriptMessage {
  speaker: "patient" | "agent";
  text: string;
}

export interface VoiceSocketState {
  sessionId: string | null;
  agentState: AgentState;
  /** Persistent conversation history. The live caption alone is not enough: it
   * only exists while the agent is speaking, so a reply the user looked away
   * from (or one whose TTS produced no audio) would vanish with no trace. */
  messages: TranscriptMessage[];
  partialTranscript: string;
  finalTranscript: string;
  agentCaption: string;
  emergency: EmergencyInfo | null;
  booking: BookingInfo | null;
  error: VoiceError | null;
  sessionOutcome: string | null;
}

interface UseVoiceSocketOptions {
  consentVersion: string;
  patientId: string | null;
  /** Speak an agent turn (browser speechSynthesis). `onDone` returns the UI to
   * listening, since the browser -- not the server -- knows when speech ends. */
  onSpeak: (text: string, onDone: () => void) => void;
  /** Stop speech immediately: barge-in, emergency pre-emption, disconnect. */
  onStopSpeaking: () => void;
}

const INITIAL_STATE: VoiceSocketState = {
  sessionId: null,
  agentState: "connecting",
  messages: [],
  partialTranscript: "",
  finalTranscript: "",
  agentCaption: "",
  emergency: null,
  booking: null,
  error: null,
  sessionOutcome: null,
};

function wsUrl(sessionId: string, ticket: string): string {
  const httpBase = apiBaseUrl();
  const wsBase = httpBase.replace(/^http/, "ws");
  return `${wsBase}/ws/voice/${sessionId}?ticket=${encodeURIComponent(ticket)}`;
}

export function useVoiceSocket(opts: UseVoiceSocketOptions) {
  const { consentVersion, patientId, onSpeak, onStopSpeaking } = opts;
  const [state, setState] = useState<VoiceSocketState>(INITIAL_STATE);

  const wsRef = useRef<WebSocket | null>(null);
  const agentStateRef = useRef<AgentState>("connecting");

  // Held in a ref so the socket effect doesn't re-run (and reconnect, burning a
  // single-use ticket) every time the caller re-renders with new closures.
  const handlersRef = useRef({ onSpeak, onStopSpeaking });
  handlersRef.current = { onSpeak, onStopSpeaking };

  const patch = useCallback((partial: Partial<VoiceSocketState>) => {
    setState((prev) => {
      const next = { ...prev, ...partial };
      if (next.agentState !== prev.agentState) agentStateRef.current = next.agentState;
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;

    // The voice ticket is single-use (server-enforced via Redis SETNX). It must be
    // fetched fresh inside this effect rather than passed in as a prop: React 18
    // StrictMode double-invokes effects on mount in dev, and a ticket fetched
    // earlier (e.g. in the button click handler) would be burned by the first,
    // throwaway invocation, leaving the second with an already-used ticket.
    async function connect() {
      let sessionId: string;
      let ticket: string;
      try {
        const resp = await apiFetch<{ session_id: string; ticket: string }>("/api/v1/voice/sessions", {
          method: "POST",
        });
        sessionId = resp.session_id;
        ticket = resp.ticket;
      } catch {
        if (!cancelled) {
          patch({
            agentState: "closed",
            error: { code: "session_create_failed", recoverable: false, message: "Could not start the voice session." },
          });
        }
        return;
      }
      if (cancelled) return;

      patch({ sessionId });
      ws = new WebSocket(wsUrl(sessionId, ticket));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      wireSocket(ws);
    }

    function wireSocket(ws: WebSocket) {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "session_start",
            consent_version: consentVersion,
            patient_id: patientId,
            language: "en",
          })
        );
      };

      ws.onmessage = (event) => {
        let msg: { type: string; [key: string]: unknown };
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (msg.type) {
          case "ready":
            patch({ agentState: "thinking" });
            break;
          case "partial_transcript":
            patch({ partialTranscript: msg.text as string });
            break;
          case "final_transcript":
            setState((prev) => ({
              ...prev,
              finalTranscript: msg.text as string,
              partialTranscript: "",
              messages: [...prev.messages, { speaker: "patient", text: msg.text as string }],
            }));
            break;
          case "agent_thinking":
            patch({ agentState: "thinking" });
            break;
          case "agent_text": {
            const caption = msg.text as string;
            // speak_text is normalize_for_tts()'d server-side ("10:30" -> "ten
            // thirty"); the caption keeps the original for readability.
            const spoken = (msg.speak_text as string) ?? caption;
            setState((prev) => ({
              ...prev,
              agentCaption: caption,
              messages: [...prev.messages, { speaker: "agent", text: caption }],
            }));
            handlersRef.current.onSpeak(spoken, () => {
              if (agentStateRef.current === "speaking") patch({ agentState: "listening" });
            });
            break;
          }
          case "audio_start":
            patch({ agentState: "speaking" });
            break;
          case "audio_end":
            // The browser speaks asynchronously; speechSynthesis's own onend
            // moves us back to "listening" (see VoiceAgent), so nothing here.
            break;
          case "stop_playback":
            handlersRef.current.onStopSpeaking?.();
            patch({ agentState: "listening" });
            break;
          case "emergency":
            handlersRef.current.onStopSpeaking?.();
            patch({
              agentState: "emergency",
              emergency: {
                severity: msg.severity as string,
                category: msg.category as string,
                numbers: msg.numbers as string[],
              },
            });
            break;
          case "booking_confirmed":
            patch({
              booking: {
                appointmentId: msg.appointment_id as string,
                payload: (msg.payload as Record<string, unknown>) ?? {},
              },
            });
            break;
          case "error":
            patch({
              error: {
                code: msg.code as string,
                recoverable: msg.recoverable as boolean,
                message: msg.message as string,
              },
            });
            break;
          case "session_summary":
            // The server has closed the session (the agent called end_session, or
            // the user hung up). Reflect that in the UI rather than sitting in
            // "listening" against a session that no longer exists.
            patch({ sessionOutcome: msg.outcome as string, agentState: "closed" });
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        handlersRef.current.onStopSpeaking?.();
        if (agentStateRef.current !== "emergency") patch({ agentState: "closed" });
      };

      ws.onerror = () => {
        patch({ error: { code: "ws_error", recoverable: false, message: "Connection lost." } });
      };
    }

    connect();

    return () => {
      cancelled = true;
      handlersRef.current.onStopSpeaking?.();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentVersion, patientId]);

  const sendJson = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** Bundles the local playback stop with the server notification -- must happen
   * together so the client never waits on a round-trip to go silent (section 10.2:
   * "Barge-in must abort within 150ms"). */
  const bargeIn = useCallback(() => {
    handlersRef.current.onStopSpeaking?.();
    patch({ agentState: "listening" });
    sendJson({ type: "barge_in" });
  }, [patch, sendJson]);

  const speechStart = useCallback(() => {
    patch({ partialTranscript: "" });
    sendJson({ type: "speech_start", ts: Date.now() });
  }, [patch, sendJson]);

  const speechEnd = useCallback(
    (text: string, confidence: number, durationMs: number) => {
      // The browser did the transcription, so the text travels with the event.
      patch({ agentState: "thinking", partialTranscript: "" });
      sendJson({
        type: "speech_end",
        ts: Date.now(),
        duration_ms: durationMs,
        text,
        confidence,
      });
    },
    [patch, sendJson]
  );

  const sendText = useCallback(
    (text: string) => {
      // Appended locally: handle_text_input on the server goes straight to the
      // agent without echoing a final_transcript frame back (unlike the speech
      // path), so nothing else would ever add the typed message to history.
      setState((prev) => ({
        ...prev,
        finalTranscript: text,
        agentState: "thinking",
        messages: [...prev.messages, { speaker: "patient", text }],
      }));
      agentStateRef.current = "thinking";
      sendJson({ type: "text_input", text });
    },
    [sendJson]
  );

  const endSession = useCallback(
    (reason = "user_hangup") => {
      sendJson({ type: "session_end", reason });
    },
    [sendJson]
  );

  return useMemo(
    () => ({ state, agentStateRef, bargeIn, speechStart, speechEnd, sendText, endSession }),
    [state, bargeIn, speechStart, speechEnd, sendText, endSession]
  );
}
