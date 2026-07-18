import { canTransition, type LeadState } from "@deepblue/core";
import { events, leads } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only: move one lead to another lifecycle state (e.g. retire a test
 * lead to dead). Transitions respect canTransition — no teleporting.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as {
    leadId?: string;
    state?: LeadState;
    reason?: string;
  } | null;
  if (!body?.leadId || !body?.state) {
    return Response.json({ ok: false, error: "leadId y state requeridos" }, { status: 400 });
  }

  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, body.leadId)).limit(1);
  if (!lead) return Response.json({ ok: false, error: "lead no encontrado" }, { status: 404 });
  if (!canTransition(lead.state, body.state)) {
    return Response.json(
      { ok: false, error: `transición ${lead.state} → ${body.state} no permitida` },
      { status: 400 },
    );
  }

  await db
    .update(leads)
    .set({
      state: body.state,
      updatedAt: new Date(),
      ...(body.state === "dead" ? { deadReason: body.reason ?? "retired via dev" } : {}),
    })
    .where(eq(leads.id, lead.id));
  await db.insert(events).values({
    userId: lead.userId,
    leadId: lead.id,
    type: "lead_state_changed",
    payload: { from: lead.state, to: body.state, reason: body.reason, source: "dev" },
  });

  return Response.json({ ok: true, from: lead.state, to: body.state });
}
