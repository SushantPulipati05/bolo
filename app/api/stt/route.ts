import { transcribe, STT_MODES, type SttMode } from "@/lib/sarvam";
import { checkAccess, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

// Keep uploads small. Short clips in WebM/Opus are well under this.
// Also note: Sarvam's real-time REST endpoint accepts up to 30 seconds of audio.
const MAX_BYTES = 3 * 1024 * 1024;

export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing audio 'file'" }, { status: 400 });
    }
    if (file.size === 0) {
      return Response.json({ error: "Audio file is empty" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: "Audio file too large" }, { status: 413 });
    }

    const modeRaw = String(form.get("mode") ?? "codemix");
    if (!STT_MODES.includes(modeRaw as SttMode)) {
      return Response.json({ error: `Invalid mode '${modeRaw}'` }, { status: 400 });
    }

    const lang = form.get("language_code");
    const languageCode = typeof lang === "string" && lang && lang !== "unknown" ? lang : undefined;

    const result = await transcribe(file, file.name || "audio.webm", modeRaw as SttMode, languageCode);
    return Response.json({
      transcript: result.transcript,
      languageCode: result.language_code,
      languageProbability: result.language_probability,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
