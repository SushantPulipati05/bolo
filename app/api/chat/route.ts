import { chat, type ChatMessage } from "@/lib/sarvam";
import { checkAccess, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 4000;

function isValidMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return false;
  return value.every(
    (m) =>
      m &&
      typeof m === "object" &&
      ["system", "user", "assistant"].includes((m as ChatMessage).role) &&
      typeof (m as ChatMessage).content === "string" &&
      (m as ChatMessage).content.length <= MAX_CONTENT_CHARS,
  );
}

export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as { messages?: unknown };
    if (!isValidMessages(body.messages)) {
      return Response.json({ error: "Invalid 'messages'" }, { status: 400 });
    }
    const { text, finishReason } = await chat(body.messages);
    return Response.json({ text, finishReason });
  } catch (e) {
    return errorResponse(e);
  }
}
