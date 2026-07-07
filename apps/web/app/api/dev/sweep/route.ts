import { NEGOTIATION_HEADROOM, type JobPayload } from "@deepblue/core";
import { briefs, jobs } from "@deepblue/db";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only stand-in for Cloud Scheduler: enqueue one search sweep per
 * platform per vehicle of every active brief. Skips briefs with queued jobs.
 */
const PLATFORMS = ["wallapop", "autoscout24"] as const;
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const activeBriefs = await db.select().from(briefs).where(eq(briefs.status, "active"));
  let created = 0;

  for (const brief of activeBriefs) {
    const [pending] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, brief.userId), eq(jobs.status, "queued")))
      .limit(1);
    if (pending) continue;

    for (const vehicle of brief.criteria.vehicles) {
      for (const platform of PLATFORMS) {
        const payload: JobPayload = {
          type: "search_sweep",
          platform,
          briefId: brief.id,
          query: {
            keywords: `${vehicle.make} ${vehicle.model}`,
            make: vehicle.make,
            model: vehicle.model,
            // Asking prices above budget within negotiation headroom still matter.
            priceMaxEur: Math.round(brief.hardLimits.maxPriceEur * NEGOTIATION_HEADROOM),
            // Floor skips financing/installment posts (329€ "cars") and wrecks.
            priceMinEur: Math.round(brief.hardLimits.maxPriceEur * 0.3),
            yearMin: brief.criteria.yearMin,
            kmMax: brief.criteria.kmMax,
            fuel: brief.criteria.fuel?.length === 1 ? brief.criteria.fuel[0] : undefined,
            location: brief.criteria.location,
          },
        };
        await db.insert(jobs).values({ userId: brief.userId, type: payload.type, payload });
        created += 1;
      }
    }
  }

  return Response.json({ ok: true, jobsCreated: created });
}
