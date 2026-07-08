/** Shared re-evaluation: one lead, current data, dossier and benchmark. */

import {
  applyEnrichment,
  canTransition,
  evaluateListing,
  type ModelDossier,
  type NormalizedListing,
  type PriceBenchmark,
} from "@deepblue/core";
import { briefs, events, leads, listings, type Db } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getBenchmark, getDossier } from "./lookups";

type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;
type LeadRow = typeof leads.$inferSelect;

export interface EvalCaches {
  benchmark: Map<string, PriceBenchmark | undefined>;
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

export async function reevaluateLead(
  db: Db,
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
  caches: EvalCaches,
): Promise<{ overall: string; outcome: string }> {
  const nl = listingRowToNormalized(listing, brief);
  const benchmark = await getBenchmark(db, nl.make, nl.model, nl.countryCode, caches.benchmark);
  const dossier = await getDossier(db, nl.make, nl.model, caches.dossier);
  const evaluation = evaluateListing(nl, brief.criteria, brief.hardLimits, benchmark, dossier);

  // Rules rebuild the verdict from scratch; a stored LLM enrichment is
  // re-merged on top (bounded deltas, vetoes reapplied inside).
  const verdict = lead.enrichment
    ? applyEnrichment(evaluation.verdict, lead.enrichment, brief.criteria.riskTolerance ?? "medium")
    : evaluation.verdict;

  const nextState =
    evaluation.outcome === "dead" && canTransition(lead.state, "dead")
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
