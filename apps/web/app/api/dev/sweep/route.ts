import { getDb } from "../../../../lib/db";
import { enqueueSweeps } from "../../../../lib/sweep";

/** Dev-only manual trigger; the scheduler / Cloud Scheduler do this in real use. */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();
  const jobsCreated = await enqueueSweeps(db);
  return Response.json({ ok: true, jobsCreated });
}
