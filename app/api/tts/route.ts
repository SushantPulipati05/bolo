import { speak } from "@/lib/sarvam";
import { checkAccess, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_TEXT_CHARS = 600;

export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as {
      text?: unknown;
      languageCode?: unknown;
      speaker?: unknown;
    };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return Response.json({ error: "Missing 'text'" }, { status: 400 });
    }
    if (body.text.length > MAX_TEXT_CHARS) {
      return Response.json({ error: `Text too long (max ${MAX_TEXT_CHARS} characters)` }, { status: 400 });
    }
    const languageCode = typeof body.languageCode === "string" ? body.languageCode : "en-IN";
    const speaker = typeof body.speaker === "string" && body.speaker ? body.speaker : undefined;

    const audio = await speak(body.text, languageCode, speaker);
    return Response.json(audio);
  } catch (e) {
    return errorResponse(e);
  }
}
