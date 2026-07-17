import type { JobPayload } from "@deepblue/core";
import { approvals, jobs, leads, listings, messages } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { decideLeadApproval, draftOutreach, sendUserMessage } from "../../../../lib/outreach";

/**
 * Dev-only outreach driver (same code paths as the lead page buttons).
 * GET  ?leadId=…                          → conversation + pending approvals
 * POST { leadId, action: "draft" }        → compose a draft + approval
 * POST { leadId, action: "approve"|"reject" } → decide the pending approval
 * POST { leadId, action: "fetch" }        → enqueue fetch_replies now
 * POST { leadId, action: "send", body }   → queue a user-authored reply
 */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const leadId = new URL(req.url).searchParams.get("leadId");
  if (!leadId) return Response.json({ ok: false, error: "falta leadId" }, { status: 400 });

  const db = await getDb();
  const conversation = await db
    .select()
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(desc(messages.createdAt));
  const pending = await db
    .select({ id: approvals.id, kind: approvals.kind, status: approvals.status, createdAt: approvals.createdAt })
    .from(approvals)
    .where(eq(approvals.leadId, leadId))
    .orderBy(desc(approvals.createdAt));
  return Response.json({ ok: true, conversation, approvals: pending });
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    leadId?: string;
    action?: "draft" | "approve" | "reject" | "fetch" | "send" | "dedup-inbound";
    body?: string;
  } | null;
  if (!body?.leadId || !body.action) {
    return Response.json({ ok: false, error: "leadId y action son obligatorios" }, { status: 400 });
  }

  const db = await getDb();
  if (body.action === "dedup-inbound") {
    // Remove duplicate inbound rows (same externalId), keeping the oldest.
    const rows = await db
      .select({ id: messages.id, externalId: messages.externalId, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.leadId, body.leadId))
      .orderBy(messages.createdAt);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const m of rows) {
      if (!m.externalId) continue;
      if (seen.has(m.externalId)) dupes.push(m.id);
      else seen.add(m.externalId);
    }
    for (const id of dupes) await db.delete(messages).where(eq(messages.id, id));
    return Response.json({ ok: true, removed: dupes.length });
  }
  if (body.action === "fetch") {
    const [row] = await db
      .select({ userId: leads.userId, platform: listings.platform, platformListingId: listings.platformListingId })
      .from(leads)
      .innerJoin(listings, eq(leads.listingId, listings.id))
      .where(eq(leads.id, body.leadId))
      .limit(1);
    if (!row) return Response.json({ ok: false, error: "lead no encontrado" }, { status: 404 });
    const payload: JobPayload = {
      type: "fetch_replies",
      platform: row.platform,
      platformListingId: row.platformListingId,
    };
    const [job] = await db
      .insert(jobs)
      .values({ userId: row.userId, type: payload.type, payload })
      .returning({ id: jobs.id });
    return Response.json({ ok: true, jobId: job?.id });
  }

  const result =
    body.action === "draft"
      ? await draftOutreach(db, body.leadId)
      : body.action === "send"
        ? await sendUserMessage(db, body.leadId, body.body ?? "")
        : await decideLeadApproval(db, body.leadId, body.action);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
