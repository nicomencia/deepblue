/** Shared re-evaluation: one lead, current data, dossier and benchmark. */

import {
  applyEnrichment,
  canTransition,
  evaluateListing,
  type ModelDossier,
  type NormalizedListing,
} from "@deepblue/core";
import { briefs, events, leads, listings, type Db } from "@deepblue/db";
import { and, eq, or, sql } from "drizzle-orm";
import { getBenchmark, getDossier, type ComparableCache } from "./lookups";

type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;
type LeadRow = typeof leads.$inferSelect;

export interface EvalCaches {
  benchmark: ComparableCache;
  dossier: Map<string, ModelDossier | undefined>;
}

export function newEvalCaches(): EvalCaches {
  return { benchmark: new Map(), dossier: new Map() };
}

export function listingRowToNormalized(
  listing: ListingRow,
  brief?: BriefRow,
): NormalizedListing {
  // Listings ingested before make/model columns existed may have them null;
  // a lead matched a brief vehicle by definition, so recover them from it.
  const matched = brief?.criteria.vehicles.find(
    (v) =>
      listing.title.toLowerCase().includes(v.make.toLowerCase()) &&
      listing.title.toLowerCase().includes(v.model.toLowerCase()),
  );
  return {
    platform: listing.platform,
    platformListingId: listing.platformListingId,
    url: listing.url,
    title: listing.title,
    description: listing.description ?? undefined,
    priceEur: listing.priceEur ?? undefined,
    cashPriceEur: listing.cashPriceEur ?? undefined,
    make: listing.make ?? matched?.make,
    model: listing.model ?? matched?.model,
    version: listing.version ?? undefined,
    year: listing.year ?? undefined,
    km: listing.km ?? undefined,
    fuel: listing.fuel ?? undefined,
    gearbox: listing.gearbox ?? undefined,
    powerCv: listing.powerCv ?? undefined,
    ecoLabel: listing.ecoLabel ?? undefined,
    countryCode: listing.countryCode ?? undefined,
    sellerType: listing.sellerType ?? undefined,
    sellerName: listing.sellerName ?? undefined,
    sellerRating: listing.sellerRating ?? undefined,
    sellerReviewCount: listing.sellerReviewCount ?? undefined,
    sellerSoldCount: listing.sellerSoldCount ?? undefined,
    locationText: listing.locationText ?? undefined,
    lat: listing.lat ?? undefined,
    lon: listing.lon ?? undefined,
    raw: listing.raw,
  };
}

/**
 * Re-evaluate every shortlisted lead on a make+model — the step that makes a
 * dossier change (created, disabled, re-enabled) land on verdicts immediately.
 */
export async function reevaluateModelLeads(
  db: Db,
  make: string,
  model: string,
): Promise<number> {
  const mk = make.toLowerCase();
  const md = model.toLowerCase();
  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(
      and(
        eq(leads.state, "shortlisted"),
        or(
          and(
            sql`lower(${listings.make}) = ${mk}`,
            sql`lower(${listings.model}) = ${md}`,
          ),
          // Legacy rows without make/model columns: match on the title.
          and(
            sql`${listings.title} ilike ${"%" + mk + "%"}`,
            sql`${listings.title} ilike ${"%" + md + "%"}`,
          ),
        ),
      ),
    );

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }
  return rows.length;
}

export async function reevaluateLead(
  db: Db,
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
  caches: EvalCaches,
): Promise<{ overall: string; outcome: string }> {
  const nl = listingRowToNormalized(listing, brief);
  const benchmark = await getBenchmark(
    db,
    nl.make,
    nl.model,
    nl.countryCode,
    { version: nl.version, year: nl.year, powerCv: nl.powerCv },
    caches.benchmark,
  );
  const dossier = await getDossier(db, nl.make, nl.model, caches.dossier);
  const evaluation = evaluateListing(
    nl,
    brief.criteria,
    brief.hardLimits,
    benchmark,
    dossier,
    lead.issueFindings ?? undefined,
  );

  // Rules rebuild the verdict from scratch; a stored LLM enrichment is
  // re-merged on top (bounded deltas, vetoes reapplied inside).
  const verdict = lead.enrichment
    ? applyEnrichment(evaluation.verdict, lead.enrichment, brief.criteria.riskTolerance ?? "medium")
    : evaluation.verdict;

  // Manual (adopted) leads never die on hard filters — the user explicitly
  // wants this ad tracked; the reason stays visible as a warning instead.
  // The reaper still kills them honestly when the ad is truly gone.
  const nextState =
    evaluation.outcome === "dead" && lead.origin !== "manual" && canTransition(lead.state, "dead")
      ? ("dead" as const)
      : lead.state;

  await db
    .update(leads)
    .set({
      verdict,
      state: nextState,
      deadReason: evaluation.deadReason,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));

  await db.insert(events).values({
    userId: lead.userId,
    leadId: lead.id,
    type: "lead_reevaluated",
    payload: { overall: verdict.overall, outcome: evaluation.outcome },
  });

  return { overall: verdict.overall, outcome: evaluation.outcome };
}
