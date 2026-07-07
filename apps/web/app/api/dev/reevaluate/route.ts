import {
  canTransition,
  evaluateListing,
  type ModelDossier,
  type NormalizedListing,
  type PriceBenchmark,
} from "@deepblue/core";
import { briefs, events, leads, listings } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { getBenchmark, getDossier } from "../../../../lib/ingest";

/**
 * Dev-only: re-run evaluation for all shortlisted leads with the current
 * dossier and price benchmark (both improve over time).
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.state, "shortlisted"));

  const benchmarkCache = new Map<string, PriceBenchmark | undefined>();
  const dossierCache = new Map<string, ModelDossier | undefined>();
  let reevaluated = 0;
  let died = 0;

  for (const { lead, listing, brief } of rows) {
    // Listings ingested before make/model columns existed may have them null;
    // a shortlisted lead matched a brief vehicle by definition, so recover them.
    const matched = brief.criteria.vehicles.find(
      (v) =>
        listing.title.toLowerCase().includes(v.make.toLowerCase()) &&
        listing.title.toLowerCase().includes(v.model.toLowerCase()),
    );
    const nl: NormalizedListing = {
      platform: listing.platform,
      platformListingId: listing.platformListingId,
      url: listing.url,
      title: listing.title,
      description: listing.description ?? undefined,
      priceEur: listing.priceEur ?? undefined,
      make: listing.make ?? matched?.make,
      model: listing.model ?? matched?.model,
      version: listing.version ?? undefined,
      year: listing.year ?? undefined,
      km: listing.km ?? undefined,
      fuel: listing.fuel ?? undefined,
      gearbox: listing.gearbox ?? undefined,
      sellerType: listing.sellerType ?? undefined,
      sellerName: listing.sellerName ?? undefined,
      locationText: listing.locationText ?? undefined,
      lat: listing.lat ?? undefined,
      lon: listing.lon ?? undefined,
      raw: listing.raw,
    };

    const benchmark = await getBenchmark(db, nl.make, nl.model, benchmarkCache);
    const dossier = await getDossier(db, nl.make, nl.model, dossierCache);
    const evaluation = evaluateListing(nl, brief.criteria, brief.hardLimits, benchmark, dossier);

    const nextState =
      evaluation.outcome === "dead" && canTransition(lead.state, "dead")
        ? ("dead" as const)
        : lead.state;
    if (nextState === "dead") died += 1;

    await db
      .update(leads)
      .set({
        verdict: evaluation.verdict,
        state: nextState,
        deadReason: evaluation.deadReason,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, lead.id));

    await db.insert(events).values({
      userId: lead.userId,
      leadId: lead.id,
      type: "lead_reevaluated",
      payload: { overall: evaluation.verdict.overall, outcome: evaluation.outcome },
    });
    reevaluated += 1;
  }

  return Response.json({ ok: true, reevaluated, died });
}
