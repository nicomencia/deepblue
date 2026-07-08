/**
 * LLM verdict enrichment: a bounded second read of the ad that the rules
 * can't do — free-text signals (maintenance mentions, accident admissions,
 * urgency language, trim/equipment), scored as clamped subscore deltas.
 * The raw enrichment is stored on the lead so every rule re-evaluation can
 * re-merge it via applyEnrichment(); vetoes and weights remain code.
 */

import {
  applyEnrichment,
  llmEnrichmentPayloadSchema,
  MAX_ENRICHMENT_DELTA,
  type LlmEnrichment,
} from "@deepblue/core";
import { briefs, events, leads, listings, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ENRICH_MODEL, getAnthropic, isLlmConfigured, messageText } from "./llm";

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

LO QUE BUSCA EL COMPRADOR: ${brief.name} · presupuesto máx ${brief.hardLimits.maxPriceEur} €${
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
  destaca (bueno y malo) del anuncio.`;
}

export async function enrichLead(
  db: Db,
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
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
  const enrichment: LlmEnrichment = {
    ...payload,
    model: ENRICH_MODEL,
    at: new Date().toISOString(),
  };

  const verdict = applyEnrichment(
    lead.verdict,
    enrichment,
    brief.criteria.riskTolerance ?? "medium",
  );

  await db
    .update(leads)
    .set({ enrichment, enrichedAt: new Date(), verdict, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));

  await db.insert(events).values({
    userId: lead.userId,
    leadId: lead.id,
    type: "lead_enriched",
    payload: {
      before: lead.verdict.overall,
      after: verdict.overall,
      scamSuspicion: payload.scamSuspicion,
      model_id: ENRICH_MODEL,
    },
  });

  return { before: lead.verdict.overall, after: verdict.overall };
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
  for (const row of rows) {
    try {
      await enrichLead(db, row.lead, row.listing, row.brief);
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
