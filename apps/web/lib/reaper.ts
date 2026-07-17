/**
 * Listing lifecycle reaper. A car that sells or is pulled must not linger on
 * the shortlist forever. But Wallapop search returns only the newest page, so
 * "stopped appearing in sweeps" cannot mean "gone" — a still-for-sale unit
 * ages off the page. So we *probe*: enqueue a check_listing job (runner hits
 * the item's own endpoint); only a platform 404 (or sold/expired flag) reaps
 * the lead. A live probe self-heals staleness by bumping lastSeenAt.
 */

import {
  DEFAULT_RECHECK_HOURS,
  type JobPayload,
  type ListingCheckResult,
} from "@deepblue/core";
import { events, jobs, leads, listings, type Db } from "@deepblue/db";
import { and, eq, inArray, lt, notInArray } from "drizzle-orm";

/** Only Wallapop can be probed today (AS24 detail/liveness is still a stub). */
const PROBEABLE_PLATFORMS = ["wallapop"] as const;

/** Bound per run so a backlog drains gently across scheduler ticks (pacing). */
const DEFAULT_MAX_CHECKS = 25;

export interface ReapEnqueueStats {
  due: number;
  enqueued: number;
}

/** Terminal jobs older than this are queue residue, not useful history. */
const JOB_RETENTION_DAYS = 7;

/**
 * Queue hygiene: drop succeeded/failed jobs past retention. The jobs table
 * is a work queue, not the audit trail — events keep the durable history —
 * so old failures shouldn't haunt the Actividad view forever.
 */
export async function pruneOldJobs(db: Db, retentionDays = JOB_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const gone = await db
    .delete(jobs)
    .where(and(inArray(jobs.status, ["succeeded", "failed"]), lt(jobs.updatedAt, cutoff)))
    .returning({ id: jobs.id });
  return gone.length;
}

/**
 * Enqueue liveness probes for shortlisted listings not re-sighted in a while
 * and not already awaiting a probe. Deaths happen later, when the runner
 * reports each result (applyListingCheck).
 */
export async function enqueueListingChecks(
  db: Db,
  limit = DEFAULT_MAX_CHECKS,
  recheckHours = Number(process.env.LISTING_RECHECK_HOURS ?? DEFAULT_RECHECK_HOURS),
): Promise<ReapEnqueueStats> {
  const cutoff = new Date(Date.now() - recheckHours * 60 * 60 * 1000);

  // Listings already awaiting a probe — don't pile duplicate jobs on them.
  const pending = await db
    .select({ id: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "check_listing"), inArray(jobs.status, ["queued", "leased"])));
  const pendingIds = pending
    .map((p) => (p.id as { platformListingId?: string }).platformListingId)
    .filter((s): s is string => Boolean(s));

  const baseWhere = and(
    eq(leads.state, "shortlisted"),
    eq(listings.active, true),
    inArray(listings.platform, PROBEABLE_PLATFORMS),
    lt(listings.lastSeenAt, cutoff),
    pendingIds.length > 0 ? notInArray(listings.platformListingId, pendingIds) : undefined,
  );

  const rows = await db
    .selectDistinct({
      userId: leads.userId,
      platform: listings.platform,
      platformListingId: listings.platformListingId,
      url: listings.url,
    })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(baseWhere)
    .limit(limit);

  for (const row of rows) {
    const payload: JobPayload = {
      type: "check_listing",
      platform: row.platform,
      platformListingId: row.platformListingId,
      url: row.url,
    };
    await db.insert(jobs).values({ userId: row.userId, type: payload.type, payload });
  }

  return { due: rows.length, enqueued: rows.length };
}

export interface ReapResult {
  status: ListingCheckResult["status"];
  reaped: number;
}

/**
 * Apply one probe result. Alive → bump lastSeenAt (self-heal). Gone → the
 * listing is dead corpus and every non-terminal lead on it dies listing_gone.
 * Reserved → leads die listing_reserved (the car isn't purchasable now); the
 * listing row stays so a later re-sighting still has context.
 */
export async function applyListingCheck(db: Db, check: ListingCheckResult): Promise<ReapResult> {
  const [listing] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.platform, check.platform),
        eq(listings.platformListingId, check.platformListingId),
      ),
    )
    .limit(1);
  if (!listing) return { status: check.status, reaped: 0 };

  if (check.status === "active") {
    await db.update(listings).set({ lastSeenAt: new Date() }).where(eq(listings.id, listing.id));
    return { status: "active", reaped: 0 };
  }

  if (check.status === "gone") {
    await db.update(listings).set({ active: false }).where(eq(listings.id, listing.id));
  }

  const deadReason = check.status === "gone" ? "listing_gone" : "listing_reserved";
  const doomed = await db
    .select({ id: leads.id, userId: leads.userId })
    .from(leads)
    .where(
      and(
        eq(leads.listingId, listing.id),
        notInArray(leads.state, ["dead", "handed_off"]),
      ),
    );

  for (const lead of doomed) {
    await db
      .update(leads)
      .set({ state: "dead", deadReason, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    await db.insert(events).values({
      userId: lead.userId,
      leadId: lead.id,
      type: "lead_reaped",
      payload: { reason: deadReason },
    });
  }

  return { status: check.status, reaped: doomed.length };
}
