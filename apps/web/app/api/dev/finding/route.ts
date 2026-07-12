import { getDb } from "../../../../lib/db";
import { applyIssueFinding, type FindingStatus } from "../../../../lib/findings";

/**
 * Dev-only: apply an issue finding programmatically (same path as the lead
 * page buttons). Body: { leadId, title, status: confirmed|ruled_out|unconfirmed, note? }
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    leadId?: string;
    title?: string;
    status?: FindingStatus;
    note?: string;
  } | null;
  if (!body?.leadId || !body.title || !body.status) {
    return Response.json({ ok: false, error: "leadId, title y status son obligatorios" }, { status: 400 });
  }

  const db = await getDb();
  const result = await applyIssueFinding(db, body.leadId, body.title, body.status, body.note);
  return Response.json({ ok: true, ...result });
}
