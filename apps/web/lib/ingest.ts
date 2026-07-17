/**
 * Ingestion: raw runner results → listings corpus → evaluated leads.
 * Every lead's journey (created, evaluated) lands in the events audit log.
 */

import {
  evaluateListing,
  extractCashPriceEur,
  extractDedupKey,
  extractImportSignals,
  fingerprintDedupKey,
  gradeAtMost,
  sanitizePowerCv,
  type ConfidenceGrade,
  type EvaluationResult,
  type JobPayload,
  type ModelDossier,
  type NormalizedListing,
} from "@deepblue/core";
import { briefs, events, jobs, leads, listings, users, type Db } from "@deepblue/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
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
  let alertsSent = 0;

  for (const item of items) {
    // One rotten item must not kill the batch: a seller once typed "1.4"
    // into horsepower and the integer column rejected the whole sweep.
    // Sanitizers catch the known garbage; this isolates the unknown kind.
    try {
      await ingestOne(db, brief, item, caches, stats, async (lead, evaluation) => {
        const alertThreshold = (process.env.ALERT_MAX_GRADE ?? "B") as ConfidenceGrade;
        if (
          owner &&
          alertsSent < MAX_ALERTS_PER_INGEST &&
          gradeAtMost(evaluation.verdict.overall, alertThreshold)
        ) {
          alertsSent += 1;
          await sendEmail({
            to: owner.email,
            subject: `deepblue · candidato ${evaluation.verdict.overall}: ${item.title}`,
            text: composeAlert(item, evaluation, lead?.id),
            html: composeAlertHtml(item, evaluation, lead?.id),
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
    { version: item.version, year: item.year, powerCv: item.powerCv },
    caches.benchmark,
  );
  const dossier = await getDossier(db, item.make, item.model, caches.dossier);
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
  if (outcome === "shortlisted") {
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

function composeAlert(
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
    ...(leadId ? [`Ficha en deepblue: ${leadUrl(leadId)}`] : []),
    `Anuncio: ${item.url}`,
  ];
  return lines.join("\n");
}

function composeAlertHtml(
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
    `<p>Confianza global: <strong>${v.overall}</strong></p>`,
    v.repairExposureEur
      ? `<p><small>Riesgos sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} € de exposición en reparaciones</small></p>`
      : "",
    v.budgetNote ? `<p><small>${esc(v.budgetNote)}</small></p>` : "",
    v.openQuestions.length > 0
      ? `<p>Preguntas clave para el vendedor:</p><ul>${v.openQuestions
          .slice(0, 3)
          .map((q) => `<li>${esc(q)}</li>`)
          .join("")}</ul>`
      : "",
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
    .where(and(eq(leads.listingId, updated.id), eq(leads.state, "shortlisted")));

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }
  return { updated: true, reevaluated: rows.length };
}
