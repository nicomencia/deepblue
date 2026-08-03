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
import { getBenchmark, getDossierForBrief, type ComparableCache } from "./lookups";

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
    rhd: listing.rhd ?? undefined,
    foreignPlates: listing.foreignPlates ?? undefined,
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
 * Re-evaluate a brief's live leads — e.g. after its hard limits change.
 * Near misses are included on purpose: widening a limit is exactly when one
 * should be promoted into the shortlist, and tightening one is when a
 * shortlisted lead should fall back to a near miss instead of dying.
 */
export async function reevaluateBriefLeads(db: Db, briefId: string): Promise<number> {
  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(
      and(
        eq(leads.briefId, briefId),
        or(eq(leads.state, "shortlisted"), eq(leads.state, "near_miss")),
      ),
    );

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }
  return rows.length;
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
    { version: nl.version, year: nl.year, powerCv: nl.powerCv, fuel: nl.fuel, gearbox: nl.gearbox },
    caches.benchmark,
  );
  const dossier = await getDossierForBrief(db, nl, brief.criteria.vehicles, caches.dossier);
  const evaluation = evaluateListing(
    nl,
    brief.criteria,
    brief.hardLimits,
    benchmark,
    dossier,
    lead.issueFindings ?? undefined,
  );

  // Rules rebuild the verdict from scratch; stored LLM layers are re-merged
  // on top in order — ad enrichment, then the conversation reading — each
  // with bounded deltas and veto caps reapplied inside applyEnrichment.
  const risk = brief.criteria.riskTolerance ?? "medium";
  let verdict = lead.enrichment
    ? applyEnrichment(evaluation.verdict, lead.enrichment, risk)
    : evaluation.verdict;
  if (lead.chatReading) {
    verdict = applyEnrichment(verdict, lead.chatReading, risk);
  }

  // Manual (adopted) leads never fall out on hard filters — the user
  // explicitly wants this ad tracked; the reason stays visible as a warning
  // instead. The reaper still kills them honestly when the ad is truly gone.
  //
  // Everything else follows the evaluation, but only where the state machine
  // allows it: a contacted lead is never demoted to near_miss mid-conversation
  // (canTransition says no), while shortlisted ↔ near_miss moves both ways as
  // the brief's limits change.
  const target = evaluation.outcome;
  const nextState =
    lead.origin !== "manual" && target !== lead.state && canTransition(lead.state, target)
      ? target
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
