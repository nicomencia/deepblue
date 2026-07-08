/**
 * Corpus maintenance: backfill text-derived columns on rows ingested before
 * extraction existed, and kill duplicate leads (same physical car, several
 * accounts). Ingest handles new arrivals; this pass cleans what's stored.
 */

import { extractCashPriceEur, extractDedupKey } from "@deepblue/core";
import { events, leads, listings, type Db } from "@deepblue/db";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";

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
