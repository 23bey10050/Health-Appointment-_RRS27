import { useEffect, useRef, useState } from "react";
import { useVoiceSocket, type AgentState } from "@/components/voice/useVoiceSocket";
import { isSpeechRecognitionSupported, useSpeechRecognition } from "@/components/voice/useSpeechRecognition";
import { useSpeechSynthesis } from "@/components/voice/useSpeechSynthesis";
import { EmergencyBanner } from "@/components/voice/EmergencyBanner";

const CONSENT_VERSION = "v1";
const LEVEL_HISTORY = 28;

type Phase = "consent" | "requesting" | "active" | "ended";
interface MicSession {
  audioContext: AudioContext;
  stream: MediaStream;
}

function closeMicSession(session: MicSession | null): void {
  if (!session) return;
  for (const track of session.stream.getTracks()) track.stop();
  session.audioContext.close().catch(() => {});
}

export function VoiceAgent({ patientId }: { patientId: string }) {
  const [phase, setPhase] = useState<Phase>("consent");
  const [micError, setMicError] = useState<string | null>(null);
  const [session, setSession] = useState<MicSession | null>(null);
  const sessionRef = useRef<MicSession | null>(null);
  sessionRef.current = session;

  async function start() {
    setMicError(null);
    setPhase("requesting");
    try {
      // AudioContext must be created inside this user-gesture handler, or the
      // browser will create it suspended (section 15).
      const audioContext = new AudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setSession({ audioContext, stream });
      setPhase("active");
    } catch (e) {
      setMicError(e instanceof Error ? e.message : "Microphone access was denied.");
      setPhase("consent");
    }
  }

  function handleClose() {
    closeMicSession(sessionRef.current);
    setSession(null);
    setPhase("ended");
  }

  useEffect(() => () => closeMicSession(sessionRef.current), []);

  if (phase === "consent" || phase === "requesting") {
    return (
      <div className="glass-card p-8 flex flex-col items-center justify-center text-center animate-slide-up">
        <div className="w-16 h-16 rounded-full bg-brand-100 flex items-center justify-center mb-4">
          <div className="w-8 h-8 rounded-full bg-brand-500 animate-pulse-ring"></div>
        </div>
        <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Talk to the intelligent assistant</h2>
        <p className="mt-4 text-slate-500 max-w-lg leading-relaxed">
          This voice assistant listens to your symptoms, can look up doctors and available slots, and
          books appointments for you. If you describe a medical emergency, the assistant will
          immediately show emergency contact numbers.
        </p>
        {/* Accuracy matters here: speech is transcribed by the browser's own
            speech service (Google, in Chrome), so audio does leave this clinic's
            servers. Saying otherwise would be false. */}
        <p className="mt-3 text-xs text-slate-400 max-w-lg leading-relaxed">
          Your speech is transcribed by your browser's built-in speech service, which may send audio
          to your browser provider. The transcript is stored with your clinic record. You can type
          instead of speaking at any time.
        </p>
        {!isSpeechRecognitionSupported() && (
          <p className="mt-3 text-sm font-medium text-amber-700 bg-amber-50 px-4 py-2 rounded-lg max-w-lg">
            Your browser doesn't support speech input. You can still use the assistant by typing.
            For voice, try Chrome or Edge.
          </p>
        )}
        {micError && <p className="mt-4 text-sm font-medium text-emergency-600 bg-emergency-50 px-4 py-2 rounded-lg">{micError}</p>}
        <button
          onClick={start}
          disabled={phase === "requesting"}
          className="mt-8 rounded-full bg-brand-600 px-8 py-3 text-sm font-semibold text-white hover:bg-brand-700 shadow-lg shadow-brand-500/30 transition-all hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
        >
          {phase === "requesting" ? "Requesting microphone..." : "I agree — Start Voice Assistant"}
        </button>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="glass-card p-8 flex flex-col items-center justify-center text-center animate-slide-up">
        <h2 className="text-xl font-bold text-slate-800">Session Ended</h2>
        <p className="mt-2 text-slate-500">The voice session has ended securely.</p>
        <button
          onClick={() => setPhase("consent")}
          className="mt-6 rounded-full border border-slate-300 bg-white/50 px-6 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
        >
          Start a new session
        </button>
      </div>
    );
  }

  if (!session) return null;

  return (
    <ActiveSession
      audioContext={session.audioContext}
      stream={session.stream}
      patientId={patientId}
      onClose={handleClose}
    />
  );
}

function ActiveSession({
  audioContext,
  stream,
  patientId,
  onClose,
}: {
  audioContext: AudioContext;
  stream: MediaStream;
  patientId: string;
  onClose: () => void;
}) {
  const { speak, cancel: cancelSpeech, supported: ttsSupported } = useSpeechSynthesis();

  const { state, agentStateRef, bargeIn, speechStart, speechEnd, sendText, endSession } = useVoiceSocket({
    consentVersion: CONSENT_VERSION,
    patientId,
    onSpeak: speak,
    onStopSpeaking: cancelSpeech,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const levelsRef = useRef<number[]>(new Array(LEVEL_HISTORY).fill(0));
  const [typedInput, setTypedInput] = useState("");
  // Live interim result from Web Speech, shown greyed-out as the patient talks.
  const [interim, setInterim] = useState("");

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, interim]);

  // Recognition is paused while the agent speaks so its own audio (played through
  // the speakers) isn't transcribed back as patient speech.
  const { supported: sttSupported } = useSpeechRecognition({
    enabled: state.agentState === "listening",
    onSpeechStart: () => {
      if (agentStateRef.current === "speaking") bargeIn();
      speechStart();
    },
    onInterim: (text) => setInterim(text),
    onFinal: (text, confidence, durationMs) => {
      setInterim("");
      speechEnd(text, confidence, durationMs);
    },
  });

  // Waveform amplitude. Previously derived from the capture worklet's PCM frames;
  // with capture gone, an AnalyserNode on the same mic stream is cheaper and
  // needs no separate module.
  useEffect(() => {
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      levelsRef.current.push(Math.sqrt(sumSq / buf.length));
      if (levelsRef.current.length > LEVEL_HISTORY) levelsRef.current.shift();
    }, 50);

    return () => {
      clearInterval(id);
      source.disconnect();
      analyser.disconnect();
    };
  }, [audioContext, stream]);

  useEffect(() => {
    if (state.agentState === "closed") onClose();
  }, [state.agentState, onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf: number;

    function draw() {
      const { width, height } = canvas!;
      ctx!.clearRect(0, 0, width, height);
      
      const cx = width / 2;
      const cy = height / 2;
      const baseRadius = 40;
      
      // Determine colors based on state
      const stateColors: Record<string, string[]> = {
        listening: ['#3b82f6', '#60a5fa', '#93c5fd'], // Blues
        speaking: ['#a855f7', '#c084fc', '#d8b4fe'], // Purples
        thinking: ['#10b981', '#34d399', '#6ee7b7'], // Teals
        emergency: ['#ef4444', '#f87171', '#fca5a5'], // Reds
        connecting: ['#94a3b8', '#cbd5e1', '#e2e8f0'], // Slates
        closed: ['#94a3b8', '#cbd5e1', '#e2e8f0']
      };
      
      const currentColors = stateColors[state.agentState] || stateColors.listening;
      
      // Average the recent levels to get an intensity (0 to 1)
      const bars = levelsRef.current;
      const avgLevel = bars.reduce((a, b) => a + b, 0) / (bars.length || 1);
      const intensity = Math.min(1, avgLevel * 10); // Exaggerate for visual effect
      
      const time = Date.now() / 1000;
      
      // Draw 3 dynamic animated rings
      for (let i = 0; i < 3; i++) {
        ctx!.beginPath();
        const offset = i * (Math.PI * 2 / 3);
        const wobble = Math.sin(time * (3 + i) + offset) * 5;
        const expand = intensity * 35 * (3 - i) / 3;
        const radius = baseRadius + wobble + expand;
          
        ctx!.arc(cx, cy, radius, 0, Math.PI * 2);
        
        ctx!.strokeStyle = currentColors[i];
        ctx!.lineWidth = 2 + intensity * 4;
        ctx!.shadowColor = currentColors[i];
        ctx!.shadowBlur = 10 + intensity * 15;
        
        if (state.agentState === 'thinking') {
          ctx!.setLineDash([15, 15]);
          ctx!.lineDashOffset = -time * 40 * (i + 1);
        } else {
          ctx!.setLineDash([]);
        }
        
        ctx!.stroke();
      }
      
      // Inner glowing core
      ctx!.beginPath();
      ctx!.arc(cx, cy, baseRadius - 5 + intensity * 10, 0, Math.PI * 2);
      ctx!.fillStyle = currentColors[0];
      ctx!.shadowColor = currentColors[0];
      ctx!.shadowBlur = 20;
      ctx!.fill();
      
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state.agentState]);

  function handleTypedSubmit() {
    const text = typedInput.trim();
    if (!text) return;
    sendText(text);
    setTypedInput("");
  }

  function handleHangUp() {
    endSession("user_hangup");
    onClose();
  }

  return (
    <div className="space-y-4 animate-slide-up">
      {state.emergency && <EmergencyBanner info={state.emergency} />}

      <div className="glass-card p-6 md:p-8">
        <div className="flex items-center justify-between border-b border-white/20 pb-4">
          <StatusPill agentState={state.agentState} />
          <button
            onClick={handleHangUp}
            className="rounded-full bg-white/40 border border-white/60 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors shadow-sm"
          >
            End session
          </button>
        </div>

        <div className="flex justify-center my-6">
          <canvas ref={canvasRef} width={300} height={200} className="w-full max-w-[300px]" />
        </div>

        <div
          ref={transcriptRef}
          className="mt-6 max-h-72 min-h-[12rem] space-y-4 overflow-y-auto rounded-xl bg-white/40 backdrop-blur-md p-4 text-sm border border-white/50 shadow-inner"
        >
          {state.messages.length === 0 && !interim && (
            <div className="h-full flex items-center justify-center text-slate-400 font-medium py-8">
              Start speaking to begin...
            </div>
          )}
          {state.messages.map((m, i) => (
            <div key={i} className={`flex ${m.speaker === "patient" ? "justify-end" : "justify-start"} animate-message`}>
              <span
                className={`inline-block max-w-[85%] rounded-2xl px-4 py-2.5 shadow-sm leading-relaxed ${
                  m.speaker === "patient" ? "bg-brand-600 text-white rounded-br-sm" : "bg-white text-slate-800 rounded-bl-sm"
                }`}
              >
                {m.text}
              </span>
            </div>
          ))}
          {interim && (
            <div className="flex justify-end animate-message">
              <span className="inline-block max-w-[85%] rounded-2xl bg-brand-100 px-4 py-2.5 italic text-brand-700 rounded-br-sm opacity-80">
                {interim}
              </span>
            </div>
          )}
          {state.agentState === "thinking" && (
            <div className="flex justify-start animate-message">
              <span className="inline-block rounded-2xl bg-white/60 px-4 py-2.5 text-slate-500 italic rounded-bl-sm flex gap-1 items-center h-10">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"></span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{animationDelay: '150ms'}}></span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{animationDelay: '300ms'}}></span>
              </span>
            </div>
          )}
        </div>

        {state.booking && (
          <div className="mt-4 rounded-xl border border-green-200 bg-green-50/80 backdrop-blur-sm p-4 text-sm text-green-800 flex items-center gap-2 animate-slide-up">
            <span className="flex-shrink-0 w-8 h-8 rounded-full bg-green-200 flex items-center justify-center text-green-700 font-bold">✓</span>
            <div>
              <p className="font-semibold">Appointment confirmed</p>
              <p className="opacity-80">Ref: {state.booking.appointmentId.slice(0, 8)}</p>
            </div>
          </div>
        )}

        {state.error && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 backdrop-blur-sm p-4 text-sm text-amber-800 animate-slide-up">
            <p className="font-semibold text-amber-900">An error occurred</p>
            {state.error.message}
          </div>
        )}

        {!sttSupported && (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Speech input isn't available in this browser -- please type below.
          </p>
        )}
        {sttSupported && !ttsSupported && (
          <p className="mt-4 rounded-lg bg-slate-50 px-4 py-2 text-sm text-slate-600">
            Your browser can't speak replies aloud, but you'll see every reply in the transcript.
          </p>
        )}

        <div className="mt-6 flex gap-3 bg-white/50 p-2 rounded-2xl border border-white/60 shadow-sm backdrop-blur-sm">
          <input
            value={typedInput}
            onChange={(e) => setTypedInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleTypedSubmit()}
            placeholder={sttSupported ? "Type your message instead..." : "Type your message..."}
            className="flex-1 bg-transparent px-4 py-2 text-sm outline-none placeholder:text-slate-600 text-slate-800"
          />
          <button
            onClick={handleTypedSubmit}
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors shadow-sm"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<AgentState, string> = {
  connecting: "Connecting...",
  thinking: "Thinking...",
  listening: "Listening",
  speaking: "Speaking",
  emergency: "Emergency",
  closed: "Session ended",
};

function StatusPill({ agentState }: { agentState: AgentState }) {
  const color =
    agentState === "emergency"
      ? "bg-red-500/10 text-red-700 border-red-500/20"
      : agentState === "listening"
        ? "bg-blue-500/10 text-blue-700 border-blue-500/20"
        : agentState === "speaking"
          ? "bg-purple-500/10 text-purple-700 border-purple-500/20"
          : "bg-slate-500/10 text-slate-600 border-slate-500/20";
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${color}`}>
      {STATUS_LABEL[agentState] ?? agentState}
    </span>
  );
}
