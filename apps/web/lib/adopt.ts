/**
 * Manual ad adoption: the user found the car themselves; deepblue does the
 * rest. A pasted URL becomes a fetch_listing job with adopt intent; when the
 * runner returns the detail, completeAdoption turns it into a manual lead:
 *  - into a matching active brief, or a new paused "Seguimiento" brief
 *    (paused = evaluation context + tab, never swept);
 *  - dossier-first: if no dossier covers the model, it is requested (API lane
 *    builds it automatically; subscription lane surfaces it in /dossiers);
 *  - manual leads never die on hard filters — the reason becomes a warning.
 * Dead stays terminal: adopting a listing whose lead already died reports
 * that instead of resurrecting it (design invariant).
 */

import {
  dossierCoversModel,
  evaluateListing,
  extractCashPriceEur,
  extractDedupKey,
  type BriefCriteria,
  type HardLimits,
  type JobPayload,
  type NormalizedListing,
} from "@deepblue/core";
import { briefs, events, jobs, leads, listings, modelDossiers, type Db } from "@deepblue/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { buildDossier } from "./dossier-builder";
import { detailImportFact } from "./ingest";
import { isLlmConfigured } from "./llm";
import { getBenchmark, getDossier } from "./lookups";
import { newEvalCaches, listingRowToNormalized, reevaluateLead } from "./reevaluate";

export interface AdoptRequest {
  url: string;
  maxPriceEur?: number;
  briefId?: string;
}

/** Wallapop item URL → platform ref. The numeric web id is provisional; the
 * runner resolves the canonical API id from the page itself. */
export function parseAdoptUrl(
  raw: string,
): { platform: "wallapop"; url: string; provisionalId: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)wallapop\.com$/.test(u.hostname)) return null;
  const match = u.pathname.match(/^\/item\/([a-z0-9-]+)/i);
  if (!match?.[1]) return null;
  const slug = match[1];
  const provisionalId = slug.match(/(\d+)$/)?.[1] ?? slug;
  return { platform: "wallapop", url: `${u.origin}${u.pathname}`, provisionalId };
}

/** Queue the adoption: one fetch_listing job carrying the adopt intent. */
export async function adoptListing(
  db: Db,
  userId: string,
  req: AdoptRequest,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const parsed = parseAdoptUrl(req.url);
  if (!parsed) {
    return { ok: false, error: "URL no reconocida: pega el enlace de un anuncio de Wallapop" };
  }

  const payload: JobPayload = {
    type: "fetch_listing",
    platform: parsed.platform,
    platformListingId: parsed.provisionalId,
    url: parsed.url,
    adopt: { maxPriceEur: req.maxPriceEur, briefId: req.briefId },
  };
  const [job] = await db
    .insert(jobs)
    .values({ userId, type: payload.type, payload })
    .returning({ id: jobs.id });
  if (!job) return { ok: false, error: "no se pudo encolar el análisis" };

  await db.insert(events).values({
    userId,
    type: "adoption_queued",
    payload: { url: parsed.url, maxPriceEur: req.maxPriceEur, briefId: req.briefId },
  });
  return { ok: true, jobId: job.id };
}

/** Dossier-first rule: any non-disabled dossier covering make+model? */
async function ensureDossierRequested(
  db: Db,
  userId: string,
  make?: string,
  model?: string,
): Promise<"ready" | "requested" | "unknown_model"> {
  if (!make || !model) return "unknown_model";
  const rows = await db
    .select({ model: modelDossiers.model })
    .from(modelDossiers)
    .where(and(eq(modelDossiers.make, make), isNull(modelDossiers.disabledAt)));
  const covered = rows.some((d) => dossierCoversModel(d.model, model));
  if (covered) return "ready";

  await db.insert(events).values({
    userId,
    type: "dossier_needed",
    payload: { make, model, reason: "manual_adoption" },
  });
  if (isLlmConfigured()) {
    // Research takes minutes — never block the runner's report request.
    void buildDossier(db, { make, model }, userId).catch(async (err: unknown) => {
      await db.insert(events).values({
        userId,
        type: "dossier_build_failed",
        payload: { make, model, error: String(err).slice(0, 300) },
      });
    });
  }
  return "requested";
}

export interface AdoptionResult {
  status: "adopted" | "already_lead" | "lead_dead";
  leadId?: string;
  briefId?: string;
  briefCreated?: boolean;
  dossier?: "ready" | "requested" | "unknown_model";
}

export async function completeAdoption(
  db: Db,
  userId: string,
  item: NormalizedListing,
  adopt: { maxPriceEur?: number; briefId?: string },
): Promise<AdoptionResult> {
  const cashPriceEur = item.cashPriceEur ?? extractCashPriceEur(item.description, item.priceEur);
  const dedupKey = extractDedupKey(item.platform, item.description);

  // Full-detail upsert: adoption is the first sighting for unswept models.
  const [listing] = await db
    .insert(listings)
    .values({
      platform: item.platform,
      platformListingId: item.platformListingId,
      url: item.url,
      title: item.title,
      description: item.description,
      imageUrl: item.imageUrl,
      priceEur: item.priceEur,
      cashPriceEur,
      dedupKey,
      rhd: detailImportFact(item, "rhd"),
      foreignPlates: detailImportFact(item, "foreignPlates"),
      make: item.make,
      model: item.model,
      version: item.version,
      year: item.year,
      km: item.km,
      fuel: item.fuel,
      gearbox: item.gearbox,
      powerCv: item.powerCv,
      ecoLabel: item.ecoLabel,
      sellerType: item.sellerType,
      sellerName: item.sellerName,
      sellerRating: item.sellerRating,
      sellerReviewCount: item.sellerReviewCount,
      sellerSoldCount: item.sellerSoldCount,
      locationText: item.locationText,
      countryCode: item.countryCode,
      lat: item.lat,
      lon: item.lon,
      raw: item.raw,
      detailFetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [listings.platform, listings.platformListingId],
      set: {
        title: item.title,
        description: item.description,
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        priceEur: item.priceEur,
        cashPriceEur,
        dedupKey,
        // Facts only fill gaps: stored (possibly user-verified) values win.
        rhd: sql`coalesce(${listings.rhd}, ${detailImportFact(item, "rhd")})`,
        foreignPlates: sql`coalesce(${listings.foreignPlates}, ${detailImportFact(item, "foreignPlates")})`,
        sellerRating: item.sellerRating,
        sellerReviewCount: item.sellerReviewCount,
        sellerSoldCount: item.sellerSoldCount,
        active: true,
        detailFetchedAt: new Date(),
        lastSeenAt: new Date(),
      },
    })
    .returning();
  if (!listing) throw new Error("adoption: listing upsert returned no row");

  // Brief: explicit > matching active > new paused "Seguimiento".
  let briefCreated = false;
  let brief = adopt.briefId
    ? (await db.select().from(briefs).where(and(eq(briefs.id, adopt.briefId), eq(briefs.userId, userId))).limit(1))[0]
    : undefined;
  if (!brief) {
    const actives = await db
      .select()
      .from(briefs)
      .where(and(eq(briefs.userId, userId), eq(briefs.status, "active")));
    const haystack = `${item.make ?? ""} ${item.model ?? ""} ${item.title}`.toLowerCase();
    brief = actives.find((b) =>
      b.criteria.vehicles.some(
        (v) => haystack.includes(v.make.toLowerCase()) && haystack.includes(v.model.toLowerCase()),
      ),
    );
  }
  if (!brief) {
    const make = item.make ?? "Coche";
    const model = item.model ?? item.title.slice(0, 30);
    const criteria: BriefCriteria = {
      vehicles: [{ make, model }],
      location: { lat: item.lat ?? 40.4168, lon: item.lon ?? -3.7038, radiusKm: 200 },
      riskTolerance: "medium",
      sellerPreference: "prefer_private",
      notes: ["Creada al adoptar un anuncio manualmente"],
    };
    const hardLimits: HardLimits = {
      maxPriceEur: adopt.maxPriceEur ?? cashPriceEur ?? item.priceEur ?? 0,
      nonNegotiables: [],
    };
    const [created] = await db
      .insert(briefs)
      .values({
        userId,
        name: `Seguimiento: ${make} ${model}`,
        status: "paused", // evaluation context + tab; never swept
        criteria,
        hardLimits,
      })
      .returning();
    if (!created) throw new Error("adoption: brief insert returned no row");
    brief = created;
    briefCreated = true;
  }

  // Dossier-first: request one when the model has none (any version counts —
  // the reviewedAt gate still governs whether it drives claims).
  const dossier = await ensureDossierRequested(db, userId, item.make, item.model);

  // Existing lead for this brief+listing? Converge instead of duplicating —
  // and dead stays dead (terminal by design), we just report it.
  const [existing] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.briefId, brief.id), eq(leads.listingId, listing.id)))
    .limit(1);
  if (existing) {
    if (existing.state === "dead") {
      return { status: "lead_dead", leadId: existing.id, briefId: brief.id, dossier };
    }
    await db.update(leads).set({ origin: "manual" }).where(eq(leads.id, existing.id));
    await reevaluateLead(
      db,
      { ...existing, origin: "manual" },
      listing,
      brief,
      newEvalCaches(),
    );
    await db.insert(events).values({
      userId,
      leadId: existing.id,
      type: "lead_adopted",
      payload: { briefId: brief.id, converged: true, dossier },
    });
    return { status: "already_lead", leadId: existing.id, briefId: brief.id, dossier };
  }

  // Evaluate and create the manual lead. Hard-filter deaths become warnings.
  const nl = listingRowToNormalized(listing, brief);
  const caches = newEvalCaches();
  const benchmark = await getBenchmark(
    db,
    nl.make,
    nl.model,
    nl.countryCode,
    { version: nl.version, year: nl.year, powerCv: nl.powerCv, fuel: nl.fuel, gearbox: nl.gearbox },
    caches.benchmark,
  );
  const reviewedDossier = await getDossier(db, nl.make, nl.model, caches.dossier, nl.year);
  const evaluation = evaluateListing(nl, brief.criteria, brief.hardLimits, benchmark, reviewedDossier);

  const [lead] = await db
    .insert(leads)
    .values({
      userId,
      briefId: brief.id,
      listingId: listing.id,
      state: "shortlisted",
      origin: "manual",
      verdict: evaluation.verdict,
      // On a live manual lead this reads as a warning, not an epitaph.
      deadReason: evaluation.deadReason,
    })
    .returning({ id: leads.id });
  if (!lead) throw new Error("adoption: lead insert returned no row");

  await db.insert(events).values({
    userId,
    leadId: lead.id,
    type: "lead_adopted",
    payload: {
      briefId: brief.id,
      briefCreated,
      overall: evaluation.verdict.overall,
      warning: evaluation.deadReason,
      dossier,
    },
  });

  return { status: "adopted", leadId: lead.id, briefId: brief.id, briefCreated, dossier };
}
