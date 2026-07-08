/**
 * Corpus maintenance: backfill text-derived columns on rows ingested before
 * extraction existed, kill duplicate leads (same physical car, several
 * accounts), and retire leads on paused platforms. Ingest handles new
 * arrivals; this pass cleans what's stored.
 */

import { ACTIVE_PLATFORMS, extractCashPriceEur, extractDedupKey } from "@deepblue/core";
import { events, leads, listings, type Db } from "@deepblue/db";
import { and, asc, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";

export async function backfillExtraction(db: Db): Promise<number> {
  const rows = await db
    .select({
      id: listings.id,
      platform: listings.platform,
      description: listings.description,
      priceEur: listings.priceEur,
    })
    .from(listings)
    .where(
      and(isNotNull(listings.description), or(isNull(listings.cashPriceEur), isNull(listings.dedupKey))),
    );

  let updated = 0;
  for (const row of rows) {
    const cashPriceEur = extractCashPriceEur(row.description ?? undefined, row.priceEur ?? undefined);
    const dedupKey = extractDedupKey(row.platform, row.description ?? undefined);
    if (cashPriceEur === undefined && dedupKey === undefined) continue;
    await db
      .update(listings)
      .set({
        ...(cashPriceEur !== undefined ? { cashPriceEur } : {}),
        ...(dedupKey !== undefined ? { dedupKey } : {}),
      })
      .where(eq(listings.id, row.id));
    updated += 1;
  }
  return updated;
}

/**
 * Among shortlisted leads sharing a dedup key within a brief, the oldest
 * survives (it may already carry conversation history later); the rest die
 * as duplicate_listing.
 */
export async function markDuplicateLeads(db: Db): Promise<number> {
  const rows = await db
    .select({ lead: leads, dedupKey: listings.dedupKey })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(and(eq(leads.state, "shortlisted"), isNotNull(listings.dedupKey)))
    .orderBy(asc(leads.createdAt));

  const seen = new Set<string>();
  let killed = 0;
  for (const { lead, dedupKey } of rows) {
    const key = `${lead.briefId}|${dedupKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    await db
      .update(leads)
      .set({ state: "dead", deadReason: "duplicate_listing", updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    await db.insert(events).values({
      userId: lead.userId,
      leadId: lead.id,
      type: "lead_marked_duplicate",
      payload: { dedupKey },
    });
    killed += 1;
  }
  return killed;
}

/**
 * Retire every non-terminal lead whose listing is on a paused platform
 * (AutoScout24 for now). Idempotent: re-running finds nothing once retired.
 * Re-activating the platform in ACTIVE_PLATFORMS stops the retiring; the
 * dead leads are not resurrected (a fresh sweep creates new ones).
 */
export async function retirePausedPlatformLeads(db: Db): Promise<number> {
  const rows = await db
    .select({ id: leads.id, userId: leads.userId })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(
      and(
        notInArray(leads.state, ["dead", "handed_off"]),
        notInArray(listings.platform, [...ACTIVE_PLATFORMS]),
      ),
    );

  for (const lead of rows) {
    await db
      .update(leads)
      .set({ state: "dead", deadReason: "platform_paused", updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    await db.insert(events).values({
      userId: lead.userId,
      leadId: lead.id,
      type: "lead_retired",
      payload: { reason: "platform_paused" },
    });
  }
  return rows.length;
}
