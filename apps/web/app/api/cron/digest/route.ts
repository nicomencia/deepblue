import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { runDigest } from "../../../../lib/digest";

/** Cloud Scheduler target: refresh verdicts and send the daily digest. */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const db = await getDb();
  const result = await runDigest(db);
  return Response.json({ ok: true, ...result });
}
