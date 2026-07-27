import { parseDiscoveryReport } from "@deepblue/core";
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

  // Same repair as the API lane: a Claude Code session hands over the same
  // "Yaris (XP90, 2006-2011)" and Wikimedia page URLs research always produces.
  let report;
  try {
    report = parseDiscoveryReport(body.report);
  } catch (err) {
    return Response.json({ ok: false, error: String(err).slice(0, 500) }, { status: 400 });
  }

  const db = await getDb();
  await saveDiscoveryReport(db, body.discoveryId, report, body.source ?? "claude-code-session");
  return Response.json({
    ok: true,
    recommendations: report.recommendations.length,
    reviewUrl: "/discovery",
  });
}
