import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { retryPendingDossiers } from "../../../../lib/brief-hunt";
import { getDb } from "../../../../lib/db";
import { isLlmConfigured } from "../../../../lib/llm";

/**
 * Dossier retry lane: any hunt still uncovered (failed build, server restart
 * mid-research, dossier disabled later) gets its research re-fired — one per
 * tick, cooldown + daily ceiling inside retryPendingDossiers. Triggered by
 * the local scheduler or Cloud Scheduler; no-op when everything is covered.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  if (!isLlmConfigured()) {
    return Response.json({ ok: false, reason: "ANTHROPIC_API_KEY not set" });
  }
  const db = await getDb();
  const stats = await retryPendingDossiers(db);
  return Response.json({ ok: true, ...stats });
}
