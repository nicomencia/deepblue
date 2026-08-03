/**
 * LLM verdict enrichment: a bounded second read of the ad that the rules
 * can't do — free-text signals (maintenance mentions, accident admissions,
 * urgency language, trim/equipment), scored as clamped subscore deltas.
 * The raw enrichment is stored on the lead so every rule re-evaluation can
 * re-merge it via applyEnrichment(); vetoes and weights remain code.
 */

import {
  gradeAtMost,
  llmEnrichmentPayloadSchema,
  MAX_ENRICHMENT_DELTA,
  type ConfidenceGrade,
  type LlmEnrichment,
  type LlmEnrichmentPayload,
} from "@deepblue/core";
import { briefs, events, leads, listings, users, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ENRICH_MODEL, getAnthropic, isLlmConfigured, messageText } from "./llm";
import { sendEmail } from "./email";
import { composeAlert, composeAlertHtml } from "./alerts";
import { listingRowToNormalized, newEvalCaches, reevaluateLead, type EvalCaches } from "./reevaluate";

type LeadRow = typeof leads.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;

/** Ad descriptions are capped — beyond this it's filler, not signal. */
const MAX_DESCRIPTION_CHARS = 2000;

function prompt(listing: ListingRow, brief: BriefRow, lead: LeadRow): string {
  const v = lead.verdict;
  const factorLines = v
    ? Object.entries(v.factors)
        .map(
          ([k, f]) =>
            `- ${k}: ${f.score}/100 · sabemos: ${f.known.join("; ") || "—"} · sin verificar: ${f.unverified.join("; ") || "—"}`,
        )
        .join("\n")
    : "(sin veredicto previo)";

  return `Eres el amigo mecánico que acompaña a comprar un coche de segunda mano en España.
Un sistema de reglas ya ha puntuado este anuncio; tu trabajo es LEER el texto del
anuncio y refinar esa puntuación con lo que las reglas no ven. Refinas, no mandas:
cada ajuste debe citar evidencia concreta del anuncio.

ANUNCIO (${listing.platform}):
Título: ${listing.title}
Precio: ${listing.priceEur ?? "?"} € · Año: ${listing.year ?? "?"} · Km: ${listing.km ?? "?"}
Combustible: ${listing.fuel ?? "?"} · Cambio: ${listing.gearbox ?? "?"} · Potencia: ${listing.powerCv ?? "?"} CV
Versión: ${listing.version ?? "?"} · Vendedor: ${listing.sellerName ?? "?"} (${listing.sellerType ?? "?"})${
    listing.sellerRating != null
      ? ` · valoración ${listing.sellerRating}/5 (${listing.sellerReviewCount ?? 0} reseñas)`
      : ""
  }
Descripción:
${(listing.description ?? "(sin descripción)").slice(0, MAX_DESCRIPTION_CHARS)}

LO QUE BUSCA EL COMPRADOR: ${brief.name} · ${
    brief.hardLimits.maxPriceEur !== undefined
      ? `presupuesto máx ${brief.hardLimits.maxPriceEur} €`
      : "sin presupuesto fijado (busca conocer el mercado de este modelo)"
  }${
    brief.criteria.notes?.length ? ` · condiciones: ${brief.criteria.notes.join("; ")}` : ""
  }

PUNTUACIÓN ACTUAL POR REGLAS:
${factorLines}
Preguntas ya previstas: ${v?.openQuestions.join(" | ") || "—"}

Instrucciones:
- factorAdjustments: deltas entre -${MAX_ENRICHMENT_DELTA} y +${MAX_ENRICHMENT_DELTA} SOLO donde el texto
  aporte señal real (mantenimiento documentado, nº de propietarios, golpes
  admitidos, extras/acabado que justifican precio, incoherencias km/año/texto).
  Sin señal → omite el factor. Cada delta con "reasons" citando el anuncio.
- redFlags / greenFlags: señales del texto, en español, concretas.
- scamSuspicion: true solo ante patrones claros (urgencia extrema, envío del
  coche, pago fuera de plataforma, precio imposible + historia rara). Con
  scamReason explicando el patrón.
- extraOpenQuestions: SOLO preguntas nuevas que este anuncio concreto pide a
  gritos y que no estén ya previstas.
- summary: 2–3 frases en español, honestas, sobre qué es esta unidad y qué
  destaca (bueno y malo) del anuncio.
- keyLine: UNA sola frase (máx 160 caracteres) ÚNICA de esta unidad, la que
  alguien lee al escanear una lista de veinte coches: una recomendación clara
  con su mayor punto a favor y su mayor pega concretos. Nada genérico que
  valga para cualquier coche — nombra lo específico (km, extra, precio, golpe,
  propietarios). Ej: "Merece la pena: pocos km y full equipe, pero el precio
  con financiación esconde 1.300 € más al contado."`;
}

/**
 * Persist an enrichment (from the Claude API or imported from a Claude Code
 * session) and refresh the verdict. The verdict is rebuilt from rules and the
 * enrichment merged on top — never applied over an already-enriched verdict,
 * so re-enriching a lead can't compound deltas.
 */
/**
 * Send the instant alert for a lead that has just been enriched.
 *
 * Ingest deliberately stays quiet for shortlisted leads while the LLM lane is
 * on (see ingest.ts): an alert composed before enrichment can only carry the
 * canned band phrase, because `composeUnitLine` falls back to it when there is
 * no keyLine yet. Alerting here instead costs a few minutes and buys an email
 * that says something about THIS car.
 *
 * `alertedAt` is the once-only stamp, so a later re-evaluation never re-alerts.
 */
async function alertEnrichedLead(
  db: Db,
  leadId: string,
  listing: ListingRow,
  brief: BriefRow,
): Promise<void> {
  const [fresh] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!fresh?.verdict || fresh.alertedAt || fresh.state !== "shortlisted") return;

  const grade = (process.env.ALERT_MAX_GRADE ?? "B") as ConfidenceGrade;
  const minScore = Number(process.env.ALERT_MIN_SCORE ?? 75);
  if (!gradeAtMost(fresh.verdict.overall, grade) || fresh.verdict.score < minScore) return;

  const [owner] = await db.select().from(users).where(eq(users.id, fresh.userId)).limit(1);
  if (!owner) return;

  const item = listingRowToNormalized(listing, brief);
  const evaluation = { outcome: "shortlisted" as const, verdict: fresh.verdict };
  await sendEmail({
    to: owner.email,
    subject: `deepblue · candidato ${fresh.verdict.overall}: ${item.title}`,
    text: composeAlert(item, evaluation, fresh.id),
    html: composeAlertHtml(item, evaluation, fresh.id),
  });
  await db.update(leads).set({ alertedAt: new Date() }).where(eq(leads.id, fresh.id));
}

export async function saveEnrichment(
  db: Db,
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
  payload: LlmEnrichmentPayload,
  modelId: string,
  caches: EvalCaches = newEvalCaches(),
): Promise<{ before: string; after: string }> {
  if (!lead.verdict) throw new Error(`lead ${lead.id} has no verdict to enrich`);

  const enrichment: LlmEnrichment = {
    ...payload,
    model: modelId,
    at: new Date().toISOString(),
  };
  await db
    .update(leads)
    .set({ enrichment, enrichedAt: new Date(), updatedAt: new Date() })
    .where(eq(leads.id, lead.id));

  const result = await reevaluateLead(db, { ...lead, enrichment }, listing, brief, caches);

  // The alert waits for THIS moment: only now does the lead have a keyLine,
  // and the keyLine is what makes the email worth opening.
  await alertEnrichedLead(db, lead.id, listing, brief);

  await db.insert(events).values({
    userId: lead.userId,
    leadId: lead.id,
    type: "lead_enriched",
    payload: {
      before: lead.verdict.overall,
      after: result.overall,
      scamSuspicion: payload.scamSuspicion,
      model_id: modelId,
    },
  });

  return { before: lead.verdict.overall, after: result.overall };
}

export async function enrichLead(
  db: Db,
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
  caches?: EvalCaches,
): Promise<{ before: string; after: string }> {
  if (!lead.verdict) throw new Error(`lead ${lead.id} has no verdict to enrich`);
  const client = getAnthropic();

  const msg = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(llmEnrichmentPayloadSchema) },
    messages: [{ role: "user", content: prompt(listing, brief, lead) }],
  });

  // Trust boundary: validate before it touches the verdict or the DB.
  const payload = llmEnrichmentPayloadSchema.parse(JSON.parse(messageText(msg)));
  return saveEnrichment(db, lead, listing, brief, payload, ENRICH_MODEL, caches);
}

export interface EnrichBatchStats {
  candidates: number;
  enriched: number;
  failed: number;
}

/**
 * Enrich pending shortlisted leads, best-scored first (they're the ones the
 * user will look at). Bounded per call — the scheduler ticks it, so a backlog
 * drains steadily without a cost spike.
 */
export async function enrichPendingLeads(db: Db, limit = 6): Promise<EnrichBatchStats> {
  if (!isLlmConfigured()) return { candidates: 0, enriched: 0, failed: 0 };

  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(and(eq(leads.state, "shortlisted"), isNull(leads.enrichedAt)))
    .orderBy(desc(sql`(${leads.verdict} ->> 'score')::int`))
    .limit(limit);

  const stats: EnrichBatchStats = { candidates: rows.length, enriched: 0, failed: 0 };
  const caches = newEvalCaches();
  for (const row of rows) {
    try {
      await enrichLead(db, row.lead, row.listing, row.brief, caches);
      stats.enriched += 1;
    } catch (err) {
      stats.failed += 1;
      console.error(
        `enrich failed for lead ${row.lead.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return stats;
}

// One batch at a time: several runner reports can land within seconds and the
// pending-select is not atomic — a flag beats paying Haiku twice for one lead.
let enrichInFlight = false;

/**
 * Fire-and-forget enrichment right after ingest lands new leads, so keyLines
 * appear in minutes instead of waiting for the next scheduler tick (which the
 * night window 23–08h can stretch to hours). Never blocks the caller; the
 * scheduler's regular tick still drains anything this batch didn't reach.
 */
export function enrichPendingLeadsSoon(db: Db): void {
  if (enrichInFlight || !isLlmConfigured()) return;
  enrichInFlight = true;
  void enrichPendingLeads(db)
    .catch((err: unknown) => {
      console.error("post-ingest enrich failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      enrichInFlight = false;
    });
}
