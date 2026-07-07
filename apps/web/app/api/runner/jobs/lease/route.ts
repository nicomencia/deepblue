import { jobs } from "@deepblue/db";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { getDb } from "../../../../../lib/db";
import { isAuthorizedRunner } from "../../../../../lib/runner-auth";

const LEASE_MS = 2 * 60 * 1000;

/** Lease the oldest queued job (or reclaim an expired lease). 204 = queue empty. */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedRunner(req)) return new Response("unauthorized", { status: 401 });
  const db = await getDb();
  const now = new Date();

  const [job] = await db
    .select()
    .from(jobs)
    .where(
      or(
        eq(jobs.status, "queued"),
        and(eq(jobs.status, "leased"), lt(jobs.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  if (!job) return new Response(null, { status: 204 });

  await db
    .update(jobs)
    .set({
      status: "leased",
      attempts: job.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    })
    .where(eq(jobs.id, job.id));

  return Response.json({ id: job.id, payload: job.payload, attempts: job.attempts + 1 });
}
