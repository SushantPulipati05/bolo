"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// SETUP CHECK PAGE
// Proves that each Sarvam API works from this app, with clear feedback at every step.
// The real Bolo experience (stall detection, coaching, scoring) is built on top of it.

type Health = { ok: boolean; keyConfigured: boolean; passcodeRequired: boolean };
type ChatResponse = { text: string; finishReason: string | null };
type TtsResponse = { audioBase64: string; mime: string };
type SttResponse = {
  transcript: string;
  languageCode: string | null;
  languageProbability: number | null;
};

type Status = "idle" | "running" | "success" | "error";
type MicPhase = "idle" | "requesting" | "recording" | "transcribing" | "done" | "error";

const STT_MODES = ["verbatim", "codemix", "transcribe", "translit", "translate"] as const;
type SttModeChoice = (typeof STT_MODES)[number];

const MODE_HELP: Record<SttModeChoice, string> = {
  verbatim: "word for word, keeps fillers like uhh",
  codemix: "English words in English, Indian words in native script",
  transcribe: "cleaned-up text in the spoken language",
  translit: "everything in Roman letters",
  translate: "translated to English",
};

type SttResult = SttResponse & { mode: SttModeChoice; ms: number };

const TTS_LANGUAGES = [
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "mr-IN", label: "Marathi" },
];

const DEFAULT_CHAT_PROMPT = "Say hello in Marathi in one short sentence, then translate it to English.";
const DEFAULT_TTS_TEXT = "Hello, I am Bolo. Let's practice your answer together.";

// Sarvam's real-time speech-to-text endpoint accepts at most 30 seconds of audio.
const MAX_RECORD_SECONDS = 25;
const MIN_RECORD_MS = 700;
// "No sound" warning: input stays this quiet for this long while recording.
const QUIET_LEVEL = 0.03;
const QUIET_WARN_MS = 2500;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

async function callApi<T>(path: string, passcode: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (passcode) headers.set("x-passcode", passcode);
  const res = await fetch(path, { ...init, headers });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string }).error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function micErrorMessage(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      return "Microphone access was blocked. Click the lock icon in the address bar, allow the microphone, then try again.";
    }
    if (e.name === "NotFoundError") {
      return "No microphone was found. Plug one in or check your system sound settings.";
    }
    if (e.name === "NotReadableError") {
      return "The microphone is being used by another app. Close that app and try again.";
    }
  }
  return `Microphone unavailable: ${errorText(e)}`;
}

function StatusPill({ status, labels }: { status: Status; labels?: Partial<Record<Status, string>> }) {
  const defaults: Record<Status, string> = {
    idle: "Not tested",
    running: "Testing",
    success: "Working",
    error: "Failed",
  };
  const text = labels?.[status] ?? defaults[status];
  return (
    <span className={`pill ${status}`} role="status">
      {text}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export default function SetupCheck() {
  /* ---------- server ---------- */
  const [passcode, setPasscode] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");

  /* ---------- chat ---------- */
  const [chatPrompt, setChatPrompt] = useState(DEFAULT_CHAT_PROMPT);
  const [chatStatus, setChatStatus] = useState<Status>("idle");
  const [chatOut, setChatOut] = useState("");
  const [chatError, setChatError] = useState("");
  const [chatMs, setChatMs] = useState<number | null>(null);

  /* ---------- text to speech ---------- */
  const [ttsText, setTtsText] = useState(DEFAULT_TTS_TEXT);
  const [ttsLang, setTtsLang] = useState("en-IN");
  const [ttsStatus, setTtsStatus] = useState<Status>("idle");
  const [ttsError, setTtsError] = useState("");
  const [ttsMs, setTtsMs] = useState<number | null>(null);
  const [ttsSrc, setTtsSrc] = useState("");
  const [ttsAutoplayBlocked, setTtsAutoplayBlocked] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  /* ---------- speech to text ---------- */
  const [sttMode, setSttMode] = useState<SttModeChoice>("verbatim");
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");
  const [micError, setMicError] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [recordedMs, setRecordedMs] = useState(0);
  const [results, setResults] = useState<SttResult[]>([]);
  const [runningMode, setRunningMode] = useState<SttModeChoice | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastBlobRef = useRef<Blob | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const quietShownRef = useRef(false);
  const urlRef = useRef("");

  // Latest values for callbacks that fire later (recorder events).
  const passcodeRef = useRef(passcode);
  const sttModeRef = useRef(sttMode);
  passcodeRef.current = passcode;
  sttModeRef.current = sttMode;

  /* ---------- server check ---------- */

  const loadHealth = useCallback(() => {
    setHealth(null);
    setHealthError("");
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: Health) => setHealth(h))
      .catch((e) => setHealthError(errorText(e)));
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const serverStatus: Status = healthError
    ? "error"
    : !health
      ? "running"
      : health.keyConfigured
        ? "success"
        : "error";

  const locked = Boolean(health?.passcodeRequired && !passcode);

  /* ---------- chat ---------- */

  async function testChat() {
    setChatStatus("running");
    setChatError("");
    setChatOut("");
    setChatMs(null);
    try {
      const { value, ms } = await timed(() =>
        callApi<ChatResponse>("/api/chat", passcode, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: chatPrompt }] }),
        }),
      );
      setChatMs(ms);
      if (!value.text) {
        setChatError(
          value.finishReason === "length"
            ? "The reply was cut off before it started. Raise maxTokens in lib/sarvam.ts."
            : "The model returned an empty reply. Try again.",
        );
        setChatStatus("error");
        return;
      }
      setChatOut(value.text);
      setChatStatus("success");
    } catch (e) {
      setChatError(errorText(e));
      setChatStatus("error");
    }
  }

  /* ---------- text to speech ---------- */

  async function testTts() {
    setTtsStatus("running");
    setTtsError("");
    setTtsMs(null);
    setTtsAutoplayBlocked(false);
    setTtsSrc("");
    try {
      const { value, ms } = await timed(() =>
        callApi<TtsResponse>("/api/tts", passcode, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: ttsText, languageCode: ttsLang }),
        }),
      );
      setTtsMs(ms);
      setTtsSrc(`data:${value.mime};base64,${value.audioBase64}`);
      setTtsStatus("success");
    } catch (e) {
      setTtsError(errorText(e));
      setTtsStatus("error");
    }
  }

  // Try to start playback as soon as new audio arrives.
  useEffect(() => {
    if (!ttsSrc) return;
    const el = ttsAudioRef.current;
    if (!el) return;
    el.play().catch(() => setTtsAutoplayBlocked(true));
  }, [ttsSrc]);

  /* ---------- microphone ---------- */

  function clearTimers() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current !== null) {
      window.clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }

  function stopMeter() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (meterRef.current) meterRef.current.style.width = "0%";
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function startMeter(stream: MediaStream) {
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    void ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    audioCtxRef.current = ctx;

    let smooth = 0;
    let quietSince = performance.now();
    quietShownRef.current = false;

    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 5);
      smooth = Math.max(level, smooth * 0.85);
      if (meterRef.current) meterRef.current.style.width = `${Math.round(smooth * 100)}%`;

      const now = performance.now();
      if (level > QUIET_LEVEL) {
        quietSince = now;
        if (quietShownRef.current) {
          quietShownRef.current = false;
          setQuiet(false);
        }
      } else if (!quietShownRef.current && now - quietSince > QUIET_WARN_MS) {
        quietShownRef.current = true;
        setQuiet(true);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }

  function setRecordingBlobUrl(blob: Blob) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    setRecordingUrl(url);
  }

  async function runMode(mode: SttModeChoice) {
    const blob = lastBlobRef.current;
    if (!blob) return;
    setRunningMode(mode);
    setMicError("");
    try {
      const form = new FormData();
      form.append("file", blob, blob.type.includes("mp4") ? "recording.m4a" : "recording.webm");
      form.append("mode", mode);
      const { value, ms } = await timed(() =>
        callApi<SttResponse>("/api/stt", passcodeRef.current, { method: "POST", body: form }),
      );
      setResults((prev) => [{ ...value, mode, ms }, ...prev.filter((r) => r.mode !== mode)]);
      setMicPhase("done");
    } catch (e) {
      setMicError(errorText(e));
      setMicPhase("error");
    } finally {
      setRunningMode(null);
    }
  }

  function handleRecordingStopped(mime: string) {
    const duration = performance.now() - startedAtRef.current;
    const baseType = (mime || "audio/webm").split(";")[0];
    const blob = new Blob(chunksRef.current, { type: baseType });
    if (duration < MIN_RECORD_MS || blob.size < 1000) {
      setMicError("That recording was too short. Press start, speak for a couple of seconds, then stop.");
      setMicPhase("error");
      return;
    }
    lastBlobRef.current = blob;
    setRecordedMs(duration);
    setRecordingBlobUrl(blob);
    void runMode(sttModeRef.current);
  }

  async function startRecording() {
    if (micPhase === "requesting" || micPhase === "recording" || micPhase === "transcribing") return;
    setMicError("");
    setResults([]);
    setQuiet(false);
    setElapsedMs(0);
    lastBlobRef.current = null;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError("This browser can't record audio here. Use a current Chrome, Edge or Safari on HTTPS or localhost.");
      setMicPhase("error");
      return;
    }

    setMicPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setDeviceLabel(stream.getAudioTracks()[0]?.label || "default microphone");

      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => handleRecordingStopped(rec.mimeType);
      recorderRef.current = rec;

      startMeter(stream);
      startedAtRef.current = performance.now();
      rec.start();
      setMicPhase("recording");
      tickRef.current = window.setInterval(() => {
        setElapsedMs(performance.now() - startedAtRef.current);
      }, 150);
      autoStopRef.current = window.setTimeout(stopRecording, MAX_RECORD_SECONDS * 1000);
    } catch (e) {
      clearTimers();
      stopMeter();
      releaseStream();
      setMicError(micErrorMessage(e));
      setMicPhase("error");
    }
  }

  function stopRecording() {
    clearTimers();
    stopMeter();
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      setMicPhase("transcribing");
      rec.stop();
    }
    releaseStream();
  }

  // Clean up if the page is closed or navigated away mid-recording.
  useEffect(() => {
    return () => {
      clearTimers();
      stopMeter();
      releaseStream();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recording = micPhase === "recording";
  const micBusy = micPhase === "requesting" || micPhase === "transcribing" || runningMode !== null;
  const sttStatus: Status =
    micPhase === "recording" || micPhase === "requesting" || micPhase === "transcribing"
      ? "running"
      : micPhase === "done"
        ? "success"
        : micPhase === "error"
          ? "error"
          : "idle";
  const otherModes = STT_MODES.filter((m) => !results.some((r) => r.mode === m));

  return (
    <main>
      <h1>Bolo: setup check</h1>
      <p className="sub">Confirm each Sarvam API works from this app before building the real thing.</p>

      <div className="strip" aria-label="Overall status">
        <span className="strip-item">
          <span className="small muted">Server</span>
          <StatusPill
            status={serverStatus}
            labels={{ running: "Checking", success: "Ready", error: healthError ? "Unreachable" : "Key missing" }}
          />
        </span>
        <span className="strip-item">
          <span className="small muted">Chat</span>
          <StatusPill status={chatStatus} />
        </span>
        <span className="strip-item">
          <span className="small muted">Speech out</span>
          <StatusPill status={ttsStatus} />
        </span>
        <span className="strip-item">
          <span className="small muted">Speech in</span>
          <StatusPill status={sttStatus} labels={{ running: recording ? "Recording" : "Working on it" }} />
        </span>
      </div>

      {/* ---------- 1. Server ---------- */}
      <section className="card">
        <div className="card-head">
          <h2>1. Server</h2>
          <button className="secondary" onClick={loadHealth}>
            Check again
          </button>
        </div>
        {healthError && (
          <div className="banner err" role="alert">
            Could not reach the server: {healthError}
          </div>
        )}
        {health && health.keyConfigured && (
          <div className="banner good">
            Server is up and the Sarvam API key was found.
            <span className="muted small">Passcode {health.passcodeRequired ? "required" : "not required"}.</span>
          </div>
        )}
        {health && !health.keyConfigured && (
          <div className="banner err" role="alert">
            <span className="grow">
              The server is up, but no API key was found. Put <code>SARVAM_API_KEY=your_key</code> in{" "}
              <code>.env.local</code>, then stop and restart <code>npm run dev</code>.
            </span>
          </div>
        )}
        {health?.passcodeRequired && (
          <div className="row">
            <input
              type="password"
              placeholder="Enter passcode"
              aria-label="Passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
            />
            {locked && <span className="small muted">Enter the passcode to run the tests below.</span>}
          </div>
        )}
      </section>

      {/* ---------- 2. Chat ---------- */}
      <section className="card">
        <div className="card-head">
          <h2>2. Sarvam-105B (chat)</h2>
          <StatusPill status={chatStatus} />
        </div>
        <textarea
          aria-label="Chat prompt"
          value={chatPrompt}
          onChange={(e) => setChatPrompt(e.target.value)}
          maxLength={1000}
        />
        <div className="row">
          <button onClick={testChat} disabled={chatStatus === "running" || locked || !chatPrompt.trim()}>
            {chatStatus === "running" ? "Thinking..." : "Send"}
          </button>
          {chatStatus === "running" && <Spinner />}
          {chatMs !== null && chatStatus !== "running" && (
            <span className="small muted">Answered in {fmtMs(chatMs)}</span>
          )}
        </div>
        {chatError && (
          <div className="banner err" role="alert">
            {chatError}
          </div>
        )}
        {chatOut && <div className="output">{chatOut}</div>}
      </section>

      {/* ---------- 3. Text to speech ---------- */}
      <section className="card">
        <div className="card-head">
          <h2>3. Bulbul (text to speech)</h2>
          <StatusPill status={ttsStatus} />
        </div>
        <textarea
          aria-label="Text to speak"
          value={ttsText}
          onChange={(e) => setTtsText(e.target.value)}
          maxLength={600}
        />
        <div className="row">
          <select aria-label="Language" value={ttsLang} onChange={(e) => setTtsLang(e.target.value)}>
            {TTS_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <button onClick={testTts} disabled={ttsStatus === "running" || locked || !ttsText.trim()}>
            {ttsStatus === "running" ? "Generating..." : "Speak it"}
          </button>
          {ttsStatus === "running" && <Spinner />}
          {ttsMs !== null && ttsStatus !== "running" && (
            <span className="small muted">Audio ready in {fmtMs(ttsMs)}</span>
          )}
        </div>
        {ttsError && (
          <div className="banner err" role="alert">
            {ttsError}
          </div>
        )}
        {ttsSrc && (
          <>
            {ttsAutoplayBlocked && (
              <div className="banner warn" role="status">
                Your browser blocked automatic playback. Press play below.
              </div>
            )}
            <audio ref={ttsAudioRef} src={ttsSrc} controls />
          </>
        )}
      </section>

      {/* ---------- 4. Speech to text ---------- */}
      <section className="card">
        <div className="card-head">
          <h2>4. Saaras (speech to text)</h2>
          <StatusPill
            status={sttStatus}
            labels={{ running: recording ? "Recording" : "Working on it" }}
          />
        </div>

        <div className="tip small">
          Say one sentence with a deliberate pause, like: &quot;The main idea is... uhh... that an index makes
          search faster.&quot; Then compare how each mode writes it down.
        </div>

        <div className="row">
          <label className="small muted" htmlFor="stt-mode">
            Mode
          </label>
          <select
            id="stt-mode"
            value={sttMode}
            onChange={(e) => setSttMode(e.target.value as SttModeChoice)}
            disabled={recording || micBusy}
          >
            {STT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="small muted">{MODE_HELP[sttMode]}</span>
        </div>

        <div className="row">
          {!recording ? (
            <button className="big" onClick={startRecording} disabled={micBusy || locked}>
              {micPhase === "requesting" ? "Waiting for microphone..." : "Start recording"}
            </button>
          ) : (
            <button className="big danger" onClick={stopRecording}>
              Stop and transcribe
            </button>
          )}
        </div>

        {micPhase === "requesting" && (
          <div className="banner busy" role="status">
            <Spinner />
            <span className="grow">Your browser is asking for microphone permission. Choose Allow.</span>
          </div>
        )}

        {recording && (
          <div className="banner rec" role="status" aria-live="polite">
            <span className="rec-dot" aria-hidden="true" />
            <strong>Recording</strong>
            <span className="timer">
              {fmtClock(elapsedMs)} / {fmtClock(MAX_RECORD_SECONDS * 1000)}
            </span>
            <div className="meter" role="img" aria-label="Microphone volume">
              <div className="meter-fill" ref={meterRef} />
            </div>
            <span className="small muted grow">Using: {deviceLabel}</span>
          </div>
        )}

        {recording && quiet && (
          <div className="banner warn" role="alert">
            No sound detected from your microphone. Check that it is not muted, that the right device is selected
            in your system sound settings, and speak a little louder.
          </div>
        )}

        {micPhase === "transcribing" && runningMode === null && (
          <div className="banner busy" role="status">
            <Spinner />
            <span className="grow">Recording stopped. Preparing your audio...</span>
          </div>
        )}

        {runningMode !== null && (
          <div className="banner busy" role="status">
            <Spinner />
            <span className="grow">Transcribing in {runningMode} mode...</span>
          </div>
        )}

        {micError && (
          <div className="banner err" role="alert">
            <span className="grow">{micError}</span>
            {lastBlobRef.current && (
              <button className="secondary" onClick={() => runMode(sttModeRef.current)} disabled={micBusy}>
                Try again
              </button>
            )}
          </div>
        )}

        {recordingUrl && (
          <div className="result">
            <div className="result-head">
              <strong>Your recording</strong>
              <span className="small muted">{fmtClock(recordedMs)} long. Play it to confirm it was captured.</span>
            </div>
            <audio src={recordingUrl} controls />
          </div>
        )}

        {results.map((r) => (
          <div className="result" key={r.mode}>
            <div className="result-head">
              <span className="tag">{r.mode}</span>
              <span className="small muted">
                {r.languageCode ?? "language unknown"}
                {r.languageProbability !== null ? ` (${r.languageProbability.toFixed(2)})` : ""} · {fmtMs(r.ms)}
              </span>
            </div>
            <div className="output">{r.transcript || "(empty transcript: nothing was recognized)"}</div>
          </div>
        ))}

        {results.length > 0 && otherModes.length > 0 && (
          <>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Compare the same recording in another mode (no need to speak again):
            </p>
            <div className="chip-row">
              {otherModes.map((m) => (
                <button key={m} className="secondary" onClick={() => runMode(m)} disabled={micBusy}>
                  {runningMode === m ? "Working..." : m}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
