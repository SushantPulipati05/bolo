// Thin server-side wrapper around the Sarvam REST APIs.
// Endpoints and fields follow the Sarvam docs (https://docs.sarvam.ai).
// This file only runs on the server, so the API key never reaches the browser.

// Override with SARVAM_BASE_URL only for testing against a mock server.
const BASE = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";

export class SarvamError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SarvamError";
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY;
  if (!key) {
    throw new SarvamError("SARVAM_API_KEY is not set on the server", 500);
  }
  return key;
}

async function failFrom(res: Response): Promise<never> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // ignore body read errors
  }
  throw new SarvamError(`Sarvam API ${res.status}: ${detail.slice(0, 500)}`, res.status);
}

/* ---------- Speech to text (Saaras) ---------- */

export type SttMode = "transcribe" | "translate" | "verbatim" | "translit" | "codemix";
export const STT_MODES: SttMode[] = ["transcribe", "translate", "verbatim", "translit", "codemix"];

export type SttResult = {
  request_id?: string;
  transcript: string;
  language_code: string | null;
  language_probability: number | null;
};

// Note: the real-time REST endpoint accepts audio up to 30 seconds.
export async function transcribe(
  file: Blob,
  filename: string,
  mode: SttMode = "codemix",
  languageCode?: string,
): Promise<SttResult> {
  // Browsers label recordings like "audio/webm;codecs=opus". Sarvam checks the
  // type string exactly and rejects the ";codecs=..." suffix, so send only the base type.
  const baseType = (file.type || "audio/webm").split(";")[0].trim();
  const cleanFile = new Blob([await file.arrayBuffer()], { type: baseType });

  const form = new FormData();
  form.append("file", cleanFile, filename);
  form.append("model", process.env.SARVAM_STT_MODEL ?? "saaras:v4");
  form.append("mode", mode);
  if (languageCode) form.append("language_code", languageCode);

  // Do not set Content-Type manually: fetch adds the multipart boundary.
  const res = await fetch(`${BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey() },
    body: form,
  });
  if (!res.ok) await failFrom(res);
  return (await res.json()) as SttResult;
}

/* ---------- Chat (Sarvam-105B) ---------- */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  model?: string;
  temperature?: number;
  // Thinking mode is ON by default on Sarvam-105B. Its tokens count toward
  // max_tokens, and a small budget can be used up before any answer appears.
  // We turn thinking OFF by default (fast, good for quick hints). Set
  // reasoning: true for slower, deeper answers such as scoring.
  reasoning?: boolean;
  maxTokens?: number;
};

export type ChatResult = {
  text: string;
  // "stop" = finished normally, "length" = ran out of tokens
  finishReason: string | null;
};

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const reasoning = opts.reasoning ?? false;

  const body: Record<string, unknown> = {
    model: opts.model ?? process.env.SARVAM_CHAT_MODEL ?? "sarvam-105b",
    messages,
    temperature: opts.temperature ?? (reasoning ? 0.5 : 0.2),
    max_tokens: opts.maxTokens ?? (reasoning ? 3000 : 800),
  };
  // Per the docs, reasoning_effort: null (JSON null) disables thinking mode.
  if (!reasoning) body.reasoning_effort = null;

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await failFrom(res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  };
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
  };
}

/* ---------- Text to speech (Bulbul) ---------- */

export type TtsResult = { audioBase64: string; mime: string };

export async function speak(
  text: string,
  languageCode = "en-IN",
  speaker?: string,
): Promise<TtsResult> {
  const res = await fetch(`${BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      language_code: languageCode,
      model: process.env.SARVAM_TTS_MODEL ?? "bulbul:v4-flash",
      speaker: speaker ?? process.env.SARVAM_TTS_SPEAKER ?? "simran_en_customer",
    }),
  });
  if (!res.ok) await failFrom(res);
  const data = (await res.json()) as { audios?: string[] };
  if (!data.audios?.length) {
    throw new SarvamError("Sarvam TTS returned no audio", 502);
  }
  // The API returns base64 chunks; joining them gives one WAV file.
  return { audioBase64: data.audios.join(""), mime: "audio/wav" };
}
