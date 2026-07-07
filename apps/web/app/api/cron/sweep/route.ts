import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { enqueueSweeps } from "../../../../lib/sweep";

/** Cloud Scheduler target: enqueue search sweeps for all active briefs. */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const db = await getDb();
  const jobsCreated = await enqueueSweeps(db);
  return Response.json({ ok: true, jobsCreated });
}
