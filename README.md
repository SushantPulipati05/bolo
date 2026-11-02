# Bolo

A rehearsal partner that builds fluency and confidence, with a basic clarity check.
Students practice interview and viva answers by voice, in Hinglish or a regional language.
Built with Sarvam AI: Saaras (speech to text), Sarvam-105B (coaching), Bulbul (speech out).

> Status: setup layer only. The project skeleton, the server-side Sarvam wrapper, and a setup-check
> page are in place. The Bolo features are not built yet.

## What is here

```
app/
  page.tsx            Setup-check page (tests chat, TTS, and mic -> transcript)
  layout.tsx
  globals.css
  api/
    health/route.ts   Server up? Key configured?
    chat/route.ts     Sarvam-105B
    stt/route.ts      Saaras (modes: verbatim, codemix, transcribe, translit, translate)
    tts/route.ts      Bulbul
lib/
  sarvam.ts           Server-side wrapper around the Sarvam REST APIs
  http.ts             Passcode guard + error responses
.env.example          Copy to .env.local
```

The Sarvam key is only used on the server (`lib/sarvam.ts`). The browser never sees it.

## Run it locally (Windows)

1. Install Node.js 20 or newer (check with `node --version`).
2. In this folder:
   ```
   npm install
   copy .env.example .env.local
   ```
3. Open `.env.local` and set `SARVAM_API_KEY`. Get a key at https://indus.sarvam.ai/key-management
4. Start it:
   ```
   npm run dev
   ```
5. Open http://localhost:3000 and work through the four checks on the page.

## Deploy (Vercel)

1. Push this folder to a GitHub repo (`.env.local` is git-ignored, so your key stays out).
2. In Vercel, import the repo.
3. In Project Settings -> Environment Variables, add `SARVAM_API_KEY` (and `APP_PASSCODE` to protect your credits).
4. Deploy, then open the HTTPS link on your phone. The microphone only works on HTTPS or localhost.

## Facts verified from the Sarvam docs

- Saaras `verbatim` mode keeps filler words; `codemix` keeps English words in English and Indic words in native script.
- Real-time speech-to-text accepts up to 30 seconds of audio per request (longer audio needs the Batch API).
- Timestamps are chunk-level only (sentence/phrase). There are no word-level timestamps, so pause detection
  has to be done in the browser from audio levels.
- Sarvam-105B thinking mode is on by default and its tokens count toward `max_tokens`, which can leave the
  visible reply empty. `lib/sarvam.ts` turns thinking off by default (`reasoning_effort: null`) for fast
  replies; pass `reasoning: true` for deeper answers such as scoring.
- Browsers label recordings like `audio/webm;codecs=opus`, but Sarvam rejects the `;codecs=...` suffix.
  The wrapper sends only the base type (`audio/webm`).
- Bulbul v4 Flash returns base64 audio (WAV) that must be decoded before playing.

## Next steps

See the build plan: record -> transcript with fillers -> pause detection -> clarity rubric -> rewrite -> stall hints.
