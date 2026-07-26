import { events, leads } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { deleteLeadCascade } from "../../../../lib/brief-admin";

/**
 * Dev-only: hard-delete one lead and its history. Body: { leadId, reason }.
 *
 * Deliberately NOT a revive: "leads muertos no resucitan" stays absolute, and
 * there is no dead → shortlisted transition anywhere. This removes rows that a
 * bug produced, so the ad can be adopted fresh through the normal path. The
 * reason is required and recorded — a deletion with no stated cause is exactly
 * the thing that turns an invariant into a suggestion.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    leadId?: string;
    reason?: string;
  } | null;
  if (!body?.leadId || !body?.reason) {
    return Response.json({ ok: false, error: "leadId y reason requeridos" }, { status: 400 });
  }

  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, body.leadId)).limit(1);
  if (!lead) return Response.json({ ok: false, error: "lead no encontrado" }, { status: 404 });

  // The lead's own events go with it, so the audit trail lives on the user.
  await db.insert(events).values({
    userId: lead.userId,
    type: "lead_deleted",
    payload: {
      leadId: lead.id,
      briefId: lead.briefId,
      listingId: lead.listingId,
      state: lead.state,
      deadReason: lead.deadReason,
      reason: body.reason,
      source: "dev_endpoint",
    },
  });
  await deleteLeadCascade(db, lead.id);

  return Response.json({ ok: true, deleted: lead.id, wasState: lead.state });
}
