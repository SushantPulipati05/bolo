// Live self-test for Bolo. Calls the app's own API routes, which call Sarvam.
//
//   npm run selftest                                  tests http://localhost:3000
//   npm run selftest -- https://your-app.vercel.app   tests a deployed site
//
// Start the app first (npm run dev) when testing locally.
// If the target uses a passcode, set APP_PASSCODE in .env.local or your shell.
// This script never prints your API key or passcode.

import { existsSync, readFileSync } from "node:fs";

const base = (process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

function readEnvLocal(name) {
  if (!existsSync(".env.local")) return "";
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
  }
  return "";
}

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(base);
const passcode = process.env.APP_PASSCODE || (isLocal ? readEnvLocal("APP_PASSCODE") : "");

const results = [];
const shared = {};

function headers(extra = {}) {
  return passcode ? { "x-passcode": passcode, ...extra } : extra;
}

async function jsonCall(path, body, withPasscode = true) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withPasscode ? headers() : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error ?? "request failed"}`);
  return data;
}

async function sttCall(wavBuffer, mode, mimeLabel = "audio/wav") {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: mimeLabel }), "test.wav");
  form.append("mode", mode);
  const res = await fetch(base + "/api/stt", { method: "POST", headers: headers(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error ?? "request failed"}`);
  return data;
}

function words(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

async function step(name, fn) {
  const start = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${ms} ms)${detail ? "\n        " + detail : ""}`);
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} (${ms} ms)\n        ${e instanceof Error ? e.message : e}`);
  }
}

function skip(name, why) {
  results.push({ name, ok: false, skipped: true });
  console.log(`SKIP  ${name}\n        ${why}`);
}

console.log(`\nBolo self-test against ${base}\n`);

await step("Server is up and the Sarvam key is configured", async () => {
  const res = await fetch(base + "/api/health");
  const h = await res.json();
  shared.passcodeRequired = h.passcodeRequired;
  if (!h.keyConfigured) throw new Error("No SARVAM_API_KEY on the server. Add it to .env.local and restart `npm run dev`.");
  return `passcode ${h.passcodeRequired ? "required" : "not required"}`;
});

if (shared.passcodeRequired) {
  await step("Passcode guard rejects requests without a passcode", async () => {
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}. The guard is not protecting this route.`);
    return "got 401 as expected";
  });
  if (!passcode) {
    console.log("\nA passcode is required but none was provided. Set APP_PASSCODE and run again.\n");
    process.exit(1);
  }
}

await step("Sarvam-105B answers a simple prompt", async () => {
  const d = await jsonCall("/api/chat", {
    messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
  });
  if (!d.text) throw new Error(`Empty reply (finish reason: ${d.finishReason}).`);
  return `reply: "${d.text.slice(0, 80)}"`;
});

await step("Sarvam-105B handles a Marathi prompt", async () => {
  const d = await jsonCall("/api/chat", {
    messages: [{ role: "user", content: "एका वाक्यात नमस्कार म्हणा." }],
  });
  if (!d.text) throw new Error(`Empty reply (finish reason: ${d.finishReason}).`);
  return `reply: "${d.text.slice(0, 80)}"`;
});

const EXPECTED = "Hello, this is a test of Bolo.";

await step("Bulbul speaks English and returns a valid WAV file", async () => {
  const d = await jsonCall("/api/tts", { text: EXPECTED, languageCode: "en-IN" });
  const buf = Buffer.from(d.audioBase64, "base64");
  if (buf.length < 1000) throw new Error(`Audio is only ${buf.length} bytes.`);
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("Audio is not a WAV file (no RIFF header).");
  shared.wav = buf;
  return `${Math.round(buf.length / 1024)} KB of audio`;
});

await step("Bulbul speaks Hindi", async () => {
  const d = await jsonCall("/api/tts", { text: "नमस्ते, यह बोलो का परीक्षण है।", languageCode: "hi-IN" });
  const buf = Buffer.from(d.audioBase64, "base64");
  if (buf.length < 1000) throw new Error(`Audio is only ${buf.length} bytes.`);
  return `${Math.round(buf.length / 1024)} KB of audio. Listen in the app to judge the voice.`;
});

if (shared.wav) {
  await step("Saaras transcribes Bulbul's speech back (round trip, verbatim)", async () => {
    const d = await sttCall(shared.wav, "verbatim");
    if (!d.transcript) throw new Error("Empty transcript.");
    const heard = new Set(words(d.transcript));
    const want = words(EXPECTED);
    const hit = want.filter((w) => heard.has(w)).length;
    if (hit / want.length < 0.5) {
      throw new Error(`Only ${hit}/${want.length} words matched. Heard: "${d.transcript}"`);
    }
    return `heard: "${d.transcript}" (${hit}/${want.length} words matched, language ${d.languageCode ?? "?"})`;
  });

  for (const mode of ["codemix", "transcribe"]) {
    await step(`Saaras ${mode} mode works on the same audio`, async () => {
      const d = await sttCall(shared.wav, mode);
      if (!d.transcript) throw new Error("Empty transcript.");
      return `heard: "${d.transcript}"`;
    });
  }

  await step("Browser-style audio label (with codec suffix) is accepted", async () => {
    // Browsers label recordings like "audio/webm;codecs=opus". Sarvam rejects the suffix,
    // so the server must strip it. Same idea here with a WAV label.
    const d = await sttCall(shared.wav, "verbatim", "audio/wav;codecs=1");
    if (!d.transcript) throw new Error("Empty transcript.");
    return "server stripped the codec suffix";
  });
} else {
  skip("Saaras round trip and mode checks", "No audio from the Bulbul step to send.");
}

await step("Bad input is rejected cleanly (no audio file)", async () => {
  const form = new FormData();
  form.append("mode", "verbatim");
  const res = await fetch(base + "/api/stt", { method: "POST", headers: headers(), body: form });
  if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}.`);
  return "got 400 as expected";
});

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${passed} passed, ${failed} failed (${results.length} checks)\n`);
if (failed > 0) {
  console.log("Hints: HTTP 403 from Sarvam means the API key is wrong. 429 means a rate limit or no credits left.");
  console.log("Copy the FAIL lines above and send them over if you need help.\n");
}
process.exit(failed > 0 ? 1 : 0);
