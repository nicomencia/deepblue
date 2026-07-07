/**
 * Ingestion: raw runner results → listings corpus → evaluated leads.
 * Every lead's journey (created, evaluated) lands in the events audit log.
 */

import {
  evaluateListing,
  type NormalizedListing,
  type PriceBenchmark,
} from "@deepblue/core";
import { briefs, events, leads, listings, type Db } from "@deepblue/db";
import { and, eq, sql } from "drizzle-orm";

export interface IngestStats {
  received: number;
  newLeads: number;
  shortlisted: number;
  dead: number;
}

export async function ingestSearchResults(
  db: Db,
  briefId: string,
  items: NormalizedListing[],
): Promise<IngestStats> {
  const stats: IngestStats = { received: items.length, newLeads: 0, shortlisted: 0, dead: 0 };

  const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId)).limit(1);
  if (!brief) throw new Error(`brief ${briefId} not found`);

  const benchmarkCache = new Map<string, PriceBenchmark | undefined>();

  for (const item of items) {
    // Upsert into the global corpus; price/mileage/title refresh on re-sighting.
    const [listing] = await db
      .insert(listings)
      .values({
        platform: item.platform,
        platformListingId: item.platformListingId,
        url: item.url,
        title: item.title,
        description: item.description,
        priceEur: item.priceEur,
        year: item.year,
        km: item.km,
        fuel: item.fuel,
        gearbox: item.gearbox,
        sellerType: item.sellerType,
        sellerName: item.sellerName,
        locationText: item.locationText,
        lat: item.lat,
        lon: item.lon,
        raw: item.raw,
      })
      .onConflictDoUpdate({
        target: [listings.platform, listings.platformListingId],
        set: {
          title: item.title,
          priceEur: item.priceEur,
          km: item.km,
          active: true,
          lastSeenAt: new Date(),
        },
      })
      .returning({ id: listings.id });
    if (!listing) continue;

    const [existingLead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.briefId, briefId), eq(leads.listingId, listing.id)))
      .limit(1);
    if (existingLead) continue;

    const benchmark = await getBenchmark(db, item, benchmarkCache);
    const evaluation = evaluateListing(item, brief.criteria, brief.hardLimits, benchmark);

    const [lead] = await db
      .insert(leads)
      .values({
        userId: brief.userId,
        briefId,
        listingId: listing.id,
        state: evaluation.outcome,
        verdict: evaluation.verdict,
        deadReason: evaluation.deadReason,
      })
      .returning({ id: leads.id });

    stats.newLeads += 1;
    if (evaluation.outcome === "shortlisted") stats.shortlisted += 1;
    else stats.dead += 1;

    await db.insert(events).values({
      userId: brief.userId,
      leadId: lead?.id,
      type: "lead_evaluated",
      payload: {
        outcome: evaluation.outcome,
        deadReason: evaluation.deadReason,
        overall: evaluation.verdict.overall,
        title: item.title,
        priceEur: item.priceEur,
      },
    });
  }

  return stats;
}

/**
 * Price benchmark = median over the corpus for the same make+model.
 * Grows more meaningful with every sweep; evaluateListing ignores it
 * below its minimum sample size.
 */
async function getBenchmark(
  db: Db,
  item: NormalizedListing,
  cache: Map<string, PriceBenchmark | undefined>,
): Promise<PriceBenchmark | undefined> {
  const make = item.make?.toLowerCase();
  const model = item.model?.toLowerCase();
  if (!make || !model) return undefined;

  const key = `${make}|${model}`;
  if (cache.has(key)) return cache.get(key);

  const rows = await db
    .select({
      median: sql<number | null>`percentile_cont(0.5) within group (order by ${listings.priceEur})`,
      count: sql<number>`count(*)::int`,
    })
    .from(listings)
    .where(
      and(
        sql`${listings.priceEur} is not null`,
        sql`lower(${listings.title}) like ${"%" + model + "%"}`,
      ),
    );

  const row = rows[0];
  const benchmark =
    row && row.median !== null && row.count > 0
      ? { medianEur: Number(row.median), sampleSize: row.count }
      : undefined;
  cache.set(key, benchmark);
  return benchmark;
}
