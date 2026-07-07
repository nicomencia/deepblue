import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";
import { runDigest } from "../../../../lib/digest";

/** Cloud Scheduler target: refresh verdicts and send the daily digest. */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const db = await getDb();
  // ?force=1 skips the once-per-day guard — dev only.
  const force =
    process.env.NODE_ENV !== "production" && new URL(req.url).searchParams.get("force") === "1";
  const result = await runDigest(db, { force });
  return Response.json({ ok: true, ...result });
}
