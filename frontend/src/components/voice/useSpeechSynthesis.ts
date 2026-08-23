import { useCallback, useEffect, useRef } from "react";

/** Browser speechSynthesis TTS.
 *
 * Replaces server-side Piper. The server now sends `speak_text` (already run
 * through normalize_for_tts, so "10:30" is "ten thirty") and this speaks it.
 * Barge-in and emergency pre-emption call cancel(), which is synchronous and
 * therefore faster than the old approach of draining a jitter buffer.
 */
export function useSpeechSynthesis() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!supported) return;
    // Voices load asynchronously in Chrome; getVoices() is empty on first call.
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      voiceRef.current =
        voices.find((v) => v.lang === "en-IN") ??
        voices.find((v) => v.lang.startsWith("en-GB")) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        voices[0];
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, [supported]);

  const cancel = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      if (!supported || !text.trim()) {
        onDone?.();
        return;
      }
      // Cancel first: queuing onto an in-progress utterance makes barge-in feel
      // laggy, and the agent should never be speaking two turns at once.
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.onend = () => onDone?.();
      // Fire onDone on error too, or the UI would sit in "speaking" forever.
      utterance.onerror = () => onDone?.();
      window.speechSynthesis.speak(utterance);
    },
    [supported]
  );

  // Stop speech if the component unmounts mid-utterance -- speechSynthesis is a
  // window-level singleton and would otherwise keep talking after navigation.
  useEffect(() => cancel, [cancel]);

  return { supported, speak, cancel };
}
