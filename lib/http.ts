import { SarvamError } from "./sarvam";

// If APP_PASSCODE is set on the server, every API call must send it in the
// "x-passcode" header. This keeps strangers from spending your Sarvam credits
// once the app is deployed. Returns a Response to send back, or null if allowed.
export function checkAccess(req: Request): Response | null {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return null;
  if (req.headers.get("x-passcode") !== expected) {
    return Response.json({ error: "Wrong or missing passcode" }, { status: 401 });
  }
  return null;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof SarvamError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return Response.json({ error: e.message }, { status });
  }
  console.error(e);
  return Response.json({ error: "Unexpected server error" }, { status: 500 });
}
