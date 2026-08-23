import { useEffect, useRef } from "react";

/** Browser Web Speech API STT, replacing the old AudioWorklet -> PCM16 ->
 * faster-whisper pipeline. The browser handles capture and transcription and we
 * send only text, which removed ~500MB of model weights from the server image.
 *
 * The cost is Chrome/Edge-only support, so `supported` is surfaced to the caller
 * and typed input stays first-class. Audio also goes to the browser vendor's
 * speech service (Google, on Chrome) -- the consent screen states this.
 */

// Not in TypeScript's DOM lib yet.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionResultList) => void) | null;
};
type SpeechRecognitionResultList = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
};

function getConstructor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getConstructor() !== null;
}

interface Options {
  /** Turned off while the agent is speaking so its own audio isn't transcribed. */
  enabled: boolean;
  lang?: string;
  onSpeechStart: () => void;
  onInterim: (text: string) => void;
  onFinal: (text: string, confidence: number, durationMs: number) => void;
  onError?: (error: string) => void;
}

export function useSpeechRecognition({
  enabled,
  lang = "en-IN",
  onSpeechStart,
  onInterim,
  onFinal,
  onError,
}: Options) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const startedAtRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Callbacks live in a ref so the recognition object is built once. Rebuilding
  // it on every render would abort in-flight recognition mid-utterance.
  const handlers = useRef({ onSpeechStart, onInterim, onFinal, onError });
  handlers.current = { onSpeechStart, onInterim, onFinal, onError };

  useEffect(() => {
    const Ctor = getConstructor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = lang;
    // continuous=false gives one utterance per start(); we restart in onend.
    // Chrome's continuous mode drifts and stops firing finals on long sessions.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      startedAtRef.current = Date.now();
    };
    recognition.onspeechstart = () => handlers.current.onSpeechStart();

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (result.isFinal) {
          const text = alt.transcript.trim();
          if (text) {
            handlers.current.onFinal(text, alt.confidence ?? 0, Date.now() - startedAtRef.current);
          }
        } else {
          interim += alt.transcript;
        }
      }
      if (interim) handlers.current.onInterim(interim.trim());
    };

    recognition.onerror = (e) => {
      // "no-speech" and "aborted" are routine (a silent pause, or our own stop()),
      // not conditions worth surfacing to a patient.
      if (e.error !== "no-speech" && e.error !== "aborted") {
        handlers.current.onError?.(e.error);
      }
    };

    // Auto-restart: continuous=false ends the session after each utterance, so
    // keep listening as long as the caller wants us to.
    recognition.onend = () => {
      if (!enabledRef.current) return;
      try {
        recognition.start();
      } catch {
        // Already starting -- Chrome throws InvalidStateError on a double start.
      }
    };

    recognitionRef.current = recognition;
    return () => {
      enabledRef.current = false;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [lang]);

  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (enabled) {
      try {
        recognition.start();
      } catch {
        // Already running.
      }
    } else {
      recognition.stop();
    }
  }, [enabled]);

  return { supported: isSpeechRecognitionSupported() };
}
