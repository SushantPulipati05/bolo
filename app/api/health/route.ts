export const runtime = "nodejs";

// Quick check that the server is up and configured. Never returns secret values.
export async function GET() {
  return Response.json({
    ok: true,
    keyConfigured: Boolean(process.env.SARVAM_API_KEY),
    passcodeRequired: Boolean(process.env.APP_PASSCODE),
  });
}
