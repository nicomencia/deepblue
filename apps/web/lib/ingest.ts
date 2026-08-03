/**
 * Ingestion: raw runner results → listings corpus → evaluated leads.
 * Every lead's journey (created, evaluated) lands in the events audit log.
 */

import {
  composeUnitLine,
  evaluateListing,
  extractCashPriceEur,
  extractDedupKey,
  extractImportSignals,
  fingerprintDedupKey,
  gradeAtMost,
  normalizeDrivetrain,
  sanitizePowerCv,
  type ConfidenceGrade,
  type EvaluationResult,
  type JobPayload,
  type ModelDossier,
  type NearMiss,
  type NormalizedListing,
} from "@deepblue/core";
import { briefs, events, jobs, leads, listings, users, type Db } from "@deepblue/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
import { getBenchmark, getDossierForBrief } from "./lookups";
import { applyPriceChange } from "./price-watch";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

/** Cap instant alerts per ingest batch — the rest land in the daily digest. */
const MAX_ALERTS_PER_INGEST = 3;

export interface IngestStats {
  received: number;
  newLeads: number;
  shortlisted: number;
  nearMiss: number;
  dead: number;
}

/** How a near miss reads in an email, in the user's terms. */
const MISS_LABEL: Record<string, (m: NearMiss) => string> = {
  km_over_limit: (m) =>
    `${m.actual.toLocaleString("es-ES")} km, ${Math.round(m.overshoot * 100)}% por encima de tu tope de ${m.limit.toLocaleString("es-ES")} km`,
  price_over_budget: (m) =>
    `${Math.round(m.actual).toLocaleString("es-ES")} €, ${Math.round(m.overshoot * 100)}% por encima de tu presupuesto con margen de negociación`,
  year_below_minimum: (m) => `del ${m.actual}, un año por debajo de tu mínimo (${m.limit})`,
  year_above_maximum: (m) => `del ${m.actual}, un año por encima de tu máximo (${m.limit})`,
  outside_search_radius: (m) =>
    `a ${Math.round(m.actual)} km, ${Math.round(m.overshoot * 100)}% más lejos de tu radio de ${Math.round(m.limit)} km`,
};

export const describeMiss = (m: NearMiss): string =>
  MISS_LABEL[m.reason]?.(m) ?? `fuera de límites (${m.reason})`;

/**
 * The best score currently shortlisted for a brief. A near miss only earns an
 * interruption by beating it — otherwise the user already has something better
 * that actually meets the brief, and the email is noise.
 */
async function bestShortlistedScore(db: Db, briefId: string): Promise<number> {
  const [row] = await db
    .select({
      best: sql<number>`coalesce(max((${leads.verdict}->>'score')::numeric), 0)::int`,
    })
    .from(leads)
    .where(and(eq(leads.briefId, briefId), eq(leads.state, "shortlisted")));
  return row?.best ?? 0;
}

export async function ingestSearchResults(
  db: Db,
  briefId: string,
  items: NormalizedListing[],
): Promise<IngestStats> {
  const stats: IngestStats = {
    received: items.length,
    newLeads: 0,
    shortlisted: 0,
    nearMiss: 0,
    dead: 0,
  };

  const [brief] = await db.select().from(briefs).where(eq(briefs.id, briefId)).limit(1);
  if (!brief) throw new Error(`brief ${briefId} not found`);
  const [owner] = await db.select().from(users).where(eq(users.id, brief.userId)).limit(1);

  const caches = newEvalCaches();
  let alertsSent = 0;
  // Measured once, before this batch adds anything: the bar a near miss must
  // clear is what the user already had, not what this same sweep just found.
  const barToBeat = await bestShortlistedScore(db, briefId);

  for (const item of items) {
    // One rotten item must not kill the batch: a seller once typed "1.4"
    // into horsepower and the integer column rejected the whole sweep.
    // Sanitizers catch the known garbage; this isolates the unknown kind.
    try {
      await ingestOne(db, brief, item, caches, stats, async (lead, evaluation) => {
        const alertThreshold = (process.env.ALERT_MAX_GRADE ?? "B") as ConfidenceGrade;
        // Selectivity floor: alerts are the interruption channel, and a broad
        // search produces more low-B candidates than a person can work. Only
        // the top of the band interrupts; the rest wait in the daily digest.
        const minScore = Number(process.env.ALERT_MIN_SCORE ?? 75);
        const topOfBand =
          gradeAtMost(evaluation.verdict.overall, alertThreshold) &&
          evaluation.verdict.score >= minScore;

        // A near miss is outside the brief, so it has to clear a higher bar
        // than a normal candidate: top of the band AND better than anything
        // the user already has that actually fits. Otherwise: silence. Near
        // misses never reach the daily digest either — the shortlist is the
        // digest's subject, and this is explicitly not on it.
        const nearMiss = evaluation.outcome === "near_miss";
        const worthInterrupting =
          topOfBand && (!nearMiss || evaluation.verdict.score > barToBeat);

        if (owner && alertsSent < MAX_ALERTS_PER_INGEST && worthInterrupting) {
          alertsSent += 1;
          const miss = evaluation.nearMiss;
          const note = miss ? describeMiss(miss) : undefined;
          await sendEmail({
            to: owner.email,
            subject: note
              ? `deepblue · fuera de límites pero interesante (${evaluation.verdict.overall}): ${item.title}`
              : `deepblue · candidato ${evaluation.verdict.overall}: ${item.title}`,
            text: note
              ? `Fuera de tu búsqueda: ${note}.\nTe aviso porque puntúa por encima de todo lo que tienes en la lista.\n\n${composeAlert(item, evaluation, lead?.id)}`
              : composeAlert(item, evaluation, lead?.id),
            html: note
              ? `<p style="padding:0.5rem 0.75rem;border-left:3px solid #c88"><strong>Fuera de tu búsqueda:</strong> ${note}.<br><small>Te aviso porque puntúa por encima de todo lo que tienes en la lista.</small></p>${composeAlertHtml(item, evaluation, lead?.id)}`
              : composeAlertHtml(item, evaluation, lead?.id),
          });
          // Stamp so tomorrow's digest shows it as "ya avisado", not as news.
          if (lead) {
            await db.update(leads).set({ alertedAt: new Date() }).where(eq(leads.id, lead.id));
          }
        }
      });
    } catch (err) {
      await db.insert(events).values({
        userId: brief.userId,
        type: "ingest_item_failed",
        payload: {
          platform: item.platform,
          platformListingId: item.platformListingId,
          title: item.title,
          error: String(err instanceof Error ? err.message : err).slice(0, 500),
        },
      });
    }
  }

  return stats;
}

/** Ingest a single normalized listing: upsert, lead, evaluation, alert hook. */
async function ingestOne(
  db: Db,
  brief: typeof briefs.$inferSelect,
  item: NormalizedListing,
  caches: ReturnType<typeof newEvalCaches>,
  stats: IngestStats,
  onShortlisted: (
    lead: { id: string } | undefined,
    evaluation: EvaluationResult,
  ) => Promise<void>,
): Promise<void> {
  const briefId = brief.id;
  // Text-derived facts: the real cash price behind financing-conditional
  // headlines, and the physical car's identity — the dealer's internal REF
  // when the text has one, else the exact-odometer fingerprint (AUTOHERO
  // pattern: same unit from many city accounts, no REF anywhere).
  const cashPriceEur = item.cashPriceEur ?? extractCashPriceEur(item.description, item.priceEur);
  const dedupKey = extractDedupKey(item.platform, item.description) ?? fingerprintDedupKey(item);
  // Import facts: only explicit statements are stored (assumed RHD stays an
  // inference in the verdict); never overwrite a user-verified value.
  const imp = extractImportSignals(item.title, item.description);
  const rhdFact = item.rhd ?? (imp.rhd && !imp.rhdAssumed ? true : undefined);
  const foreignPlatesFact = item.foreignPlates ?? (imp.foreignPlate ? true : undefined);
  // No marketplace exposes drivetrain as a field, so it is read out of the ad
  // text — and it has to be read, because the benchmark now prices a 4x4
  // against 4x4s. Version first (where the trade name lives: "HTRAC",
  // "4Motion", "AWD-i"), then title and description as the seller wrote them.
  const drivetrainFact =
    item.drivetrain ?? normalizeDrivetrain(item.version, item.title, item.description);

  // Snapshot the stored price BEFORE the upsert refreshes it: a re-sighted
  // listing with a different price is a price change, not background noise.
  const [preexisting] = await db
    .select({ id: listings.id, priceEur: listings.priceEur })
    .from(listings)
    .where(
      and(
        eq(listings.platform, item.platform),
        eq(listings.platformListingId, item.platformListingId),
      ),
    )
    .limit(1);

  // Upsert into the global corpus; price/mileage/title refresh on re-sighting.
  // powerCv re-sanitized here: garbage from an out-of-date runner must not
  // reach the integer column (the "1.4 CV" incident).
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
      make: item.make,
      model: item.model,
      version: item.version,
      year: item.year,
      km: item.km,
      fuel: item.fuel,
      gearbox: item.gearbox,
      drivetrain: drivetrainFact,
      powerCv: sanitizePowerCv(item.powerCv),
      ecoLabel: item.ecoLabel,
      rhd: rhdFact,
      foreignPlates: foreignPlatesFact,
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
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        // Facts only fill gaps: a stored value (possibly the user's manual
        // verification) always wins over re-extraction.
        rhd: sql`coalesce(${listings.rhd}, ${rhdFact ?? null})`,
        foreignPlates: sql`coalesce(${listings.foreignPlates}, ${foreignPlatesFact ?? null})`,
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
  if (!listing) return;

  // Price diff on re-sighting — evented and re-evaluated, drops may alert.
  if (preexisting && item.priceEur != null && preexisting.priceEur !== item.priceEur) {
    await applyPriceChange(db, listing.id, preexisting.priceEur, item.priceEur);
  }

  const [existingLead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.briefId, briefId), eq(leads.listingId, listing.id)))
    .limit(1);
  if (existingLead) return;

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
    {
      version: item.version,
      year: item.year,
      powerCv: item.powerCv,
      fuel: item.fuel,
      gearbox: item.gearbox,
      drivetrain: drivetrainFact,
    },
    caches.benchmark,
  );
  const dossier = await getDossierForBrief(db, item, brief.criteria.vehicles, caches.dossier);
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
  else if (outcome === "near_miss") stats.nearMiss += 1;
  else stats.dead += 1;

  // Shortlisted → enqueue detail enrichment (gearbox, power, eco label,
  // seller reputation). Wallapop only for now; AutoScout24 detail later.
  // Near misses deliberately skip it: they are outside the brief, and paying
  // a runner fetch plus an LLM call on every one would make the widened band
  // cost real money on ads the user never asked for.
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
  // re-evaluations (digest, enrichment) never alert, so no spam. Near misses
  // go through the same hook, which applies a stricter bar of its own.
  if (outcome === "shortlisted" || outcome === "near_miss") {
    await onShortlisted(lead, evaluation);
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

/** Explicit import fact from a listing's text, for gap-filling updates. */
export function detailImportFact(item: NormalizedListing, field: "rhd" | "foreignPlates"): boolean | null {
  const imp = extractImportSignals(item.title, item.description);
  if (field === "rhd") return imp.rhd && !imp.rhdAssumed ? true : null;
  return imp.foreignPlate ? true : null;
}

/** Exported for tests: the instant-alert text is a contract with the reader. */
export function composeAlert(
  item: NormalizedListing,
  evaluation: EvaluationResult,
  leadId?: string,
): string {
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
    `Recomendación: ${composeUnitLine(v)}`,
    ...(v.repairExposureEur
      ? [
          `Exposición en reparaciones sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} €`,
        ]
      : []),
    ...(v.budgetNote ? [v.budgetNote] : []),
    // No question list here (user rule 2026-07-17): the alert is the lead's
    // brief; questions live on the lead page, where the outreach flow uses them.
    "",
    ...(leadId ? [`Ficha en deepblue: ${leadUrl(leadId)}`] : []),
    `Anuncio: ${item.url}`,
  ];
  return lines.join("\n");
}

export function composeAlertHtml(
  item: NormalizedListing,
  evaluation: EvaluationResult,
  leadId?: string,
): string {
  const v = evaluation.verdict;
  const href = leadId ? leadUrl(leadId) : item.url;
  const specs = [
    item.priceEur !== undefined ? `${item.priceEur.toLocaleString("es-ES")} €` : undefined,
    item.year,
    item.km !== undefined ? `${item.km.toLocaleString("es-ES")} km` : undefined,
    item.locationText,
  ]
    .filter(Boolean)
    .join(" · ");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [
    `<p><strong><a href="${href}">${esc(item.title)}</a></strong><br><small>${esc(specs)}</small></p>`,
    item.imageUrl
      ? `<p><a href="${href}"><img src="${item.imageUrl}" alt="" width="320" style="max-width:100%;border-radius:6px"></a></p>`
      : "",
    `<p>Confianza global: <strong>${v.overall}</strong> — ${esc(composeUnitLine(v))}</p>`,
    v.repairExposureEur
      ? `<p><small>Riesgos sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} € de exposición en reparaciones</small></p>`
      : "",
    v.budgetNote ? `<p><small>${esc(v.budgetNote)}</small></p>` : "",
    `<p><a href="${href}">Ficha en deepblue</a> · <a href="${item.url}">anuncio original</a></p>`,
  ];
  return parts.filter(Boolean).join("\n");
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
      imageUrl: item.imageUrl,
      priceEur: item.priceEur,
      cashPriceEur: item.cashPriceEur ?? extractCashPriceEur(item.description, item.priceEur),
      dedupKey: extractDedupKey(item.platform, item.description) ?? fingerprintDedupKey(item),
      rhd: sql`coalesce(${listings.rhd}, ${detailImportFact(item, "rhd")})`,
      foreignPlates: sql`coalesce(${listings.foreignPlates}, ${detailImportFact(item, "foreignPlates")})`,
      make: item.make,
      model: item.model,
      version: item.version,
      year: item.year,
      km: item.km,
      fuel: item.fuel,
      gearbox: item.gearbox,
      powerCv: sanitizePowerCv(item.powerCv),
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
    // Near misses included: a refreshed detail (a price drop, a corrected
    // odometer) is exactly what promotes one back into the shortlist.
    .where(
      and(
        eq(leads.listingId, updated.id),
        inArray(leads.state, ["shortlisted", "near_miss"]),
      ),
    );

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }
  return { updated: true, reevaluated: rows.length };
}
