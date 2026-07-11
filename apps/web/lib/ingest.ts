/**
 * Ingestion: raw runner results → listings corpus → evaluated leads.
 * Every lead's journey (created, evaluated) lands in the events audit log.
 */

import {
  evaluateListing,
  extractCashPriceEur,
  extractDedupKey,
  gradeAtMost,
  type ConfidenceGrade,
  type EvaluationResult,
  type JobPayload,
  type ModelDossier,
  type NormalizedListing,
} from "@deepblue/core";
import { briefs, events, jobs, leads, listings, users, type Db } from "@deepblue/db";
import { and, eq, ne } from "drizzle-orm";
import { sendEmail } from "./email";
import { getBenchmark, getDossier } from "./lookups";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

/** Cap instant alerts per ingest batch — the rest land in the daily digest. */
const MAX_ALERTS_PER_INGEST = 3;

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
  const [owner] = await db.select().from(users).where(eq(users.id, brief.userId)).limit(1);

  const caches = newEvalCaches();
  const dossierCache = caches.dossier;
  let alertsSent = 0;

  for (const item of items) {
    // Text-derived facts: the real cash price behind financing-conditional
    // headlines, and the dealer's internal REF identifying the physical car.
    const cashPriceEur = item.cashPriceEur ?? extractCashPriceEur(item.description, item.priceEur);
    const dedupKey = extractDedupKey(item.platform, item.description);

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
        cashPriceEur,
        dedupKey,
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
        locationText: item.locationText,
        countryCode: item.countryCode,
        lat: item.lat,
        lon: item.lon,
        raw: item.raw,
      })
      .onConflictDoUpdate({
        target: [listings.platform, listings.platformListingId],
        set: {
          title: item.title,
          priceEur: item.priceEur,
          cashPriceEur,
          dedupKey,
          make: item.make,
          model: item.model,
          version: item.version,
          km: item.km,
          countryCode: item.countryCode,
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

    // Same physical car already leading this brief under another account
    // (same dealer REF) → the newcomer is born dead, not a second chance.
    let duplicateOf: string | undefined;
    if (dedupKey) {
      const [dup] = await db
        .select({ id: leads.id })
        .from(leads)
        .innerJoin(listings, eq(leads.listingId, listings.id))
        .where(
          and(
            eq(leads.briefId, briefId),
            eq(listings.dedupKey, dedupKey),
            ne(listings.id, listing.id),
            ne(leads.state, "dead"),
          ),
        )
        .limit(1);
      duplicateOf = dup?.id;
    }

    const benchmark = await getBenchmark(
      db,
      item.make,
      item.model,
      item.countryCode,
      { version: item.version, year: item.year, powerCv: item.powerCv },
      caches.benchmark,
    );
    const dossier = await getDossier(db, item.make, item.model, dossierCache);
    const evaluation = evaluateListing(
      item,
      brief.criteria,
      brief.hardLimits,
      benchmark,
      dossier,
    );

    const outcome = duplicateOf ? ("dead" as const) : evaluation.outcome;
    const deadReason = duplicateOf ? "duplicate_listing" : evaluation.deadReason;
    const [lead] = await db
      .insert(leads)
      .values({
        userId: brief.userId,
        briefId,
        listingId: listing.id,
        state: outcome,
        verdict: evaluation.verdict,
        deadReason,
      })
      .returning({ id: leads.id });

    stats.newLeads += 1;
    if (outcome === "shortlisted") stats.shortlisted += 1;
    else stats.dead += 1;

    // Shortlisted → enqueue detail enrichment (gearbox, power, eco label,
    // seller reputation). Wallapop only for now; AutoScout24 detail later.
    if (outcome === "shortlisted" && item.platform === "wallapop") {
      const payload: JobPayload = {
        type: "fetch_listing",
        platform: item.platform,
        platformListingId: item.platformListingId,
        url: item.url,
      };
      await db.insert(jobs).values({ userId: brief.userId, type: payload.type, payload });
    }

    // Instant alert for top-grade finds. Fires only on first evaluation —
    // re-evaluations (digest, enrichment) never alert, so no spam.
    const alertThreshold = (process.env.ALERT_MAX_GRADE ?? "B") as ConfidenceGrade;
    if (
      outcome === "shortlisted" &&
      owner &&
      alertsSent < MAX_ALERTS_PER_INGEST &&
      gradeAtMost(evaluation.verdict.overall, alertThreshold)
    ) {
      alertsSent += 1;
      await sendEmail({
        to: owner.email,
        subject: `deepblue · candidato ${evaluation.verdict.overall}: ${item.title}`,
        text: composeAlert(item, evaluation),
      });
      // Stamp so tomorrow's digest skips it — the user already saw this car.
      if (lead) {
        await db.update(leads).set({ alertedAt: new Date() }).where(eq(leads.id, lead.id));
      }
    }

    await db.insert(events).values({
      userId: brief.userId,
      leadId: lead?.id,
      type: "lead_evaluated",
      payload: {
        outcome,
        deadReason,
        overall: evaluation.verdict.overall,
        title: item.title,
        priceEur: item.priceEur,
      },
    });
  }

  return stats;
}

function composeAlert(item: NormalizedListing, evaluation: EvaluationResult): string {
  const v = evaluation.verdict;
  const specs = [
    item.priceEur !== undefined ? `${item.priceEur.toLocaleString("es-ES")} €` : undefined,
    item.year,
    item.km !== undefined ? `${item.km.toLocaleString("es-ES")} km` : undefined,
    item.locationText,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `${item.title}`,
    specs,
    "",
    `Confianza global: ${v.overall}`,
    ...(v.repairExposureEur
      ? [
          `Exposición en reparaciones sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} €`,
        ]
      : []),
    ...(v.budgetNote ? [v.budgetNote] : []),
    "",
    "Preguntas clave para el vendedor:",
    ...v.openQuestions.slice(0, 3).map((q) => `- ${q}`),
    "",
    item.url,
  ];
  return lines.join("\n");
}

/**
 * Detail enrichment result: update the listing with what the item page
 * revealed (gearbox, power, eco label, seller reputation, full description),
 * then re-evaluate every shortlisted lead on it — the new facts may answer
 * open questions or change grades in either direction.
 */
export async function ingestListingDetail(
  db: Db,
  item: NormalizedListing,
): Promise<{ updated: boolean; reevaluated: number }> {
  const [updated] = await db
    .update(listings)
    .set({
      title: item.title || undefined,
      description: item.description,
      priceEur: item.priceEur,
      cashPriceEur: item.cashPriceEur ?? extractCashPriceEur(item.description, item.priceEur),
      dedupKey: extractDedupKey(item.platform, item.description),
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
      countryCode: item.countryCode,
      raw: item.raw,
      detailFetchedAt: new Date(),
      lastSeenAt: new Date(),
    })
    .where(
      and(
        eq(listings.platform, item.platform),
        eq(listings.platformListingId, item.platformListingId),
      ),
    )
    .returning({ id: listings.id });
  if (!updated) return { updated: false, reevaluated: 0 };

  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(and(eq(leads.listingId, updated.id), eq(leads.state, "shortlisted")));

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }
  return { updated: true, reevaluated: rows.length };
}
