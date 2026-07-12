import { discoveryReportSchema } from "@deepblue/core";
import { getDb } from "../../../../lib/db";
import { saveDiscoveryReport } from "../../../../lib/discovery";

/**
 * Dev-only: import a discovery report — the no-API-key lane, where a Claude
 * Code session does the market research on the user's subscription and POSTs
 * the result here. Same zod trust boundary as the automated builder.
 * Body: { discoveryId, source?, report }
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    discoveryId?: string;
    source?: string;
    report?: unknown;
  } | null;
  if (!body?.discoveryId || body.report === undefined) {
    return Response.json(
      { ok: false, error: "discoveryId y report son obligatorios" },
      { status: 400 },
    );
  }

  const parsed = discoveryReportSchema.safeParse(body.report);
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const db = await getDb();
  await saveDiscoveryReport(db, body.discoveryId, parsed.data, body.source ?? "claude-code-session");
  return Response.json({
    ok: true,
    recommendations: parsed.data.recommendations.length,
    reviewUrl: "/discovery",
  });
}
