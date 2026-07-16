import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { sweepReplies } from "../../../../lib/outreach";

/**
 * Enqueue fetch_replies for conversations awaiting seller answers (leads in
 * contact states with sent outreach). Conservative pacing — each fetch opens
 * a browser against Wallapop; the per-listing cooldown lives in sweepReplies.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  const db = await getDb();
  const stats = await sweepReplies(db);
  return Response.json({ ok: true, ...stats });
}
