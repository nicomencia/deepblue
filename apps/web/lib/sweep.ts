/**
 * Sweep enqueueing: one search job per platform per vehicle of every active
 * brief. Called by the local scheduler, Cloud Scheduler (via /api/cron/sweep),
 * and the dev endpoint. Skips briefs that still have queued jobs so an
 * offline runner never causes a pileup.
 */

import {
  ACTIVE_PLATFORMS,
  NEGOTIATION_HEADROOM,
  sameModelFamily,
  type JobPayload,
} from "@deepblue/core";
import { briefs, events, jobs, type Db } from "@deepblue/db";
import { and, eq, sql } from "drizzle-orm";

export async function enqueueSweeps(
  db: Db,
  /** Only briefs hunting this model (e.g. right after its dossier landed). */
  filter?: { make: string; model: string },
): Promise<number> {
  let activeBriefs = await db.select().from(briefs).where(eq(briefs.status, "active"));
  if (filter) {
    activeBriefs = activeBriefs.filter((b) =>
      b.criteria.vehicles.some(
        (v) =>
          v.make.toLowerCase() === filter.make.toLowerCase() &&
          sameModelFamily(v.model, filter.model),
      ),
    );
  }
  let created = 0;

  for (const brief of activeBriefs) {
    // Per-brief, per-type: an unswept search for THIS brief is what would pile
    // up. A user-wide check would let brief 1's fresh job starve brief 2
    // forever, and queued fetch_listing jobs would block sweeps entirely.
    const [pending] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "search_sweep"),
          eq(jobs.status, "queued"),
          sql`${jobs.payload}->>'briefId' = ${brief.id}`,
        ),
      )
      .limit(1);
    if (pending) continue;

    let briefJobs = 0;
    for (const vehicle of brief.criteria.vehicles) {
      for (const platform of ACTIVE_PLATFORMS) {
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
            // Floor skips financing/installment posts (329€ "cars") and
            // wrecks — capped so a big budget on cheap old units (20k€ hunting
            // 3–5k€ vans) never silently excludes the honest end of the market.
            priceMinEur: Math.min(Math.round(brief.hardLimits.maxPriceEur * 0.3), 1500),
            yearMin: brief.criteria.yearMin,
            yearMax: brief.criteria.yearMax,
            kmMax: brief.criteria.kmMax,
            fuel: brief.criteria.fuel?.length === 1 ? brief.criteria.fuel[0] : undefined,
            location: brief.criteria.location,
          },
        };
        await db.insert(jobs).values({ userId: brief.userId, type: payload.type, payload });
        briefJobs += 1;
      }
    }
    if (briefJobs > 0) {
      await db.insert(events).values({
        userId: brief.userId,
        type: "sweep_enqueued",
        payload: { briefId: brief.id, jobs: briefJobs },
      });
      created += briefJobs;
    }
  }

  return created;
}
