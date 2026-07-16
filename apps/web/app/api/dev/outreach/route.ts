import { approvals, messages } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { decideLeadApproval, draftOutreach } from "../../../../lib/outreach";

/**
 * Dev-only outreach driver (same code paths as the lead page buttons).
 * GET  ?leadId=…                          → conversation + pending approvals
 * POST { leadId, action: "draft" }        → compose a draft + approval
 * POST { leadId, action: "approve"|"reject" } → decide the pending approval
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
    action?: "draft" | "approve" | "reject";
  } | null;
  if (!body?.leadId || !body.action) {
    return Response.json({ ok: false, error: "leadId y action son obligatorios" }, { status: 400 });
  }

  const db = await getDb();
  const result =
    body.action === "draft"
      ? await draftOutreach(db, body.leadId)
      : await decideLeadApproval(db, body.leadId, body.action);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
