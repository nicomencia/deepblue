import { jobs } from "@deepblue/db";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { getDb } from "../../../../../lib/db";
import { isAuthorizedRunner } from "../../../../../lib/runner-auth";
import { applySendResult } from "../../../../../lib/outreach";

const LEASE_MS = 2 * 60 * 1000;

/** Lease the oldest queued job (or reclaim an expired lease). 204 = queue empty. */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedRunner(req)) return new Response("unauthorized", { status: 401 });
  const db = await getDb();

  // Bounded loop: expired send_message leases are consumed (marked failed),
  // never handed out again, so we may need to look past a few of them.
  for (let i = 0; i < 10; i++) {
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

    // At-most-once for chat sends: an expired send_message lease means the
    // outcome is unknown — the text may have reached the seller before the
    // crash. Retrying risks double-texting a human, so the job dies instead.
    if (job.status === "leased" && job.payload.type === "send_message") {
      await db
        .update(jobs)
        .set({ status: "failed", lastError: "lease expired — send outcome unknown, never retried", updatedAt: now })
        .where(eq(jobs.id, job.id));
      await applySendResult(db, job.payload.messageId, {
        ok: false,
        error: "el runner no confirmó el envío (lease caducado); comprueba el chat en Wallapop antes de reintentar",
      });
      continue;
    }

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
  return new Response(null, { status: 204 });
}
