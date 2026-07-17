import { jobs } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { pruneOldJobs } from "../../../../lib/reaper";

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

/**
 * Dev-only queue cleanup. Body { action: "prune" } drops terminal jobs past
 * retention; { action: "prune", all: true } drops ALL terminal jobs now —
 * for clearing already-diagnosed failures from the Actividad view.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: string; all?: boolean } | null;
  if (body?.action !== "prune") {
    return Response.json({ ok: false, error: "action debe ser 'prune'" }, { status: 400 });
  }

  const db = await getDb();
  const pruned = await pruneOldJobs(db, body.all ? 0 : undefined);
  return Response.json({ ok: true, pruned });
}
