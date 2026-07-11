import { jobs } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: inspect the job queue (?status=queued|leased|succeeded|failed). */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  const rows = await db
    .select()
    .from(jobs)
    .where(status ? eq(jobs.status, status as never) : undefined)
    .orderBy(desc(jobs.updatedAt))
    .limit(limit);

  return Response.json(
    rows.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      payload: j.payload,
      lastError: j.lastError,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })),
  );
}
