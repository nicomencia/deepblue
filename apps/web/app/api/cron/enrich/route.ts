import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { enrichPendingLeads } from "../../../../lib/enrich-verdict";
import { isLlmConfigured } from "../../../../lib/llm";

/**
 * LLM-enrich pending shortlisted leads, a bounded batch per call. Triggered
 * by the local scheduler every tick (no-op when nothing is pending) or by
 * Cloud Scheduler in cloud deployments.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  if (!isLlmConfigured()) {
    return Response.json({ ok: false, reason: "ANTHROPIC_API_KEY not set" });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 6), 20);

  const db = await getDb();
  const stats = await enrichPendingLeads(db, limit);
  return Response.json({ ok: true, ...stats });
}
