import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { enqueueListingChecks } from "../../../../lib/reaper";

/**
 * Enqueue liveness probes for shortlisted listings due a re-check. The runner
 * executes them and reports back; genuinely-gone listings get reaped when
 * those results land. Triggered by the local scheduler or Cloud Scheduler.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);

  const db = await getDb();
  const stats = await enqueueListingChecks(db, limit);
  return Response.json({ ok: true, ...stats });
}
