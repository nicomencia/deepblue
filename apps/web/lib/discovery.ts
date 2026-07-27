/**
 * Discovery advisor: from a needs profile to concrete models worth hunting.
 * Two lanes, same trust boundary (discoveryReportSchema) and same storage:
 *  - API lane: buildDiscoveryReport (Claude + web research) — dormant until
 *    ANTHROPIC_API_KEY exists.
 *  - Subscription lane: a Claude Code session reads the profile from
 *    /api/dev/discoveries and imports the report via /api/dev/import-discovery.
 * Each accepted recommendation becomes a brief (one click in /discovery).
 */

import {
  discoveryReportSchema,
  parseDiscoveryReport,
  type BriefCriteria,
  type DiscoveryProfile,
  type DiscoveryReport,
  type HardLimits,
  type ModelRecommendation,
} from "@deepblue/core";
import { discoveries, events, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, lt, or } from "drizzle-orm";
import { DISCOVERY_MODEL, getAnthropic, messageText } from "./llm";

const MAX_SEARCHES = 12;
const MAX_TURNS = 6;

function prompt(profile: DiscoveryProfile): string {
  return `Eres un asesor experto en el mercado español de coches de segunda mano.
Un comprador te da su perfil de necesidades; tu trabajo es recomendarle de 3 a 5
modelos CONCRETOS que debería buscar, investigando precios y fiabilidad en la web.

Perfil del comprador:
${JSON.stringify(profile, null, 2)}

Reglas estrictas:
- "model": SOLO el nombre comercial con el que se anuncia el coche ("Yaris",
  "Jazz", "Mazda2"). Es la palabra con la que se busca en el portal: si le
  añades la generación o los años no encuentra NADA. La generación va en
  "generation" ("XP90", "GE", "VII") y los años en "yearMin"/"yearMax".
- Recomendaciones accionables: versiones/motores exactos a buscar y a evitar
  ("versions" y "avoidVersions" con el motivo en la propia línea).
- "priceBandEur": horquilla realista HOY en el mercado español de segunda mano
  para la configuración recomendada, coherente con el presupuesto del perfil.
- "watchouts": los puntos débiles conocidos de cada modelo, una línea cada uno.
- "discarded": los modelos que este comprador esperaría ver y por qué no entran
  (ej. "Mini Cooper S R56: mismo motor Prince con peor acceso a mecánica barata").
- Cada recomendación lleva al menos una URL real encontrada en tus búsquedas; no
  inventes fuentes. Pocas recomendaciones bien fundadas valen más que muchas.
- "imageUrl": una foto representativa de la generación recomendada, con URL REAL
  hallada en tus búsquedas (preferible Wikimedia Commons: estable y enlazable).
  Tiene que ser el ARCHIVO, no la página de descripción: sirve
  "https://commons.wikimedia.org/wiki/Special:FilePath/NOMBRE.jpg", nunca
  ".../wiki/File:NOMBRE.jpg", que devuelve HTML y se ve como imagen rota.
  Calidad de prensa: tres cuartos frontal, coche limpio, buena luz — evita fotos
  de aparcamiento cutres, interiores o traseras. Las notas de prensa oficiales
  suelen estar detrás de logins o romper el hotlink: Commons tiene fotos de
  salones y ruedas de prensa que dan el mismo resultado y no caducan.
  Si no encuentras una fiable, omite el campo — nunca inventes la URL.
- Todos los textos visibles en español.`;
}

/** One research turn; loops while the server pauses long tool interactions. */
async function draftReport(profile: DiscoveryProfile): Promise<DiscoveryReport> {
  const client = getAnthropic();
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt(profile) }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await client.messages
      .stream({
        model: DISCOVERY_MODEL,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: MAX_SEARCHES }],
        output_config: { format: zodOutputFormat(discoveryReportSchema) },
        messages,
      })
      .finalMessage();

    if (msg.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: msg.content }];
      continue;
    }
    // Trust boundary: validate, then repair the model/imageUrl the research
    // reliably gets wrong. The repair is a function, not a schema transform —
    // zodOutputFormat above cannot represent one.
    return parseDiscoveryReport(JSON.parse(messageText(msg)));
  }
  throw new Error(`el análisis de descubrimiento no convergió en ${MAX_TURNS} turnos`);
}

/** Store a validated report. Shared by the API lane and the manual import lane. */
export async function saveDiscoveryReport(
  db: Db,
  discoveryId: string,
  report: DiscoveryReport,
  source: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(discoveries)
    .where(eq(discoveries.id, discoveryId))
    .limit(1);
  if (!row) throw new Error(`discovery ${discoveryId} not found`);

  await db
    .update(discoveries)
    .set({ report, reportSource: source, status: "ready", reportAt: new Date() })
    .where(eq(discoveries.id, discoveryId));

  await db.insert(events).values({
    userId: row.userId,
    type: "discovery_report",
    payload: {
      discoveryId,
      recommendations: report.recommendations.length,
      discarded: report.discarded.length,
      source,
    },
  });
}

/**
 * A run left `analyzing` for longer than this is treated as dead (server
 * restart mid-research, process killed) and may be reclaimed. Generous on
 * purpose: MAX_TURNS × 12 web searches is minutes of work, and reclaiming a
 * run that is merely slow buys the double billing this guard exists to stop.
 */
export const ANALYSIS_STALE_MS = 20 * 60 * 1000;

/** Nobody else is analysing this profile → the caller may. Atomic. */
export async function claimDiscoveryAnalysis(db: Db, discoveryId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - ANALYSIS_STALE_MS);
  // One UPDATE, so two concurrent clicks contend for the same row and exactly
  // one comes back with it. Reading-then-writing would let both read `pending`.
  const claimed = await db
    .update(discoveries)
    .set({ status: "analyzing", analysisStartedAt: new Date() })
    .where(
      and(
        eq(discoveries.id, discoveryId),
        or(
          eq(discoveries.status, "pending"),
          and(
            eq(discoveries.status, "analyzing"),
            lt(discoveries.analysisStartedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: discoveries.id });
  return claimed.length > 0;
}

/** Give the mark back so a failed run can be retried instead of stranding. */
async function releaseDiscoveryAnalysis(db: Db, discoveryId: string): Promise<void> {
  await db
    .update(discoveries)
    .set({ status: "pending", analysisStartedAt: null })
    .where(and(eq(discoveries.id, discoveryId), eq(discoveries.status, "analyzing")));
}

export async function buildDiscoveryReport(db: Db, discoveryId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(discoveries)
    .where(eq(discoveries.id, discoveryId))
    .limit(1);
  if (!row) throw new Error(`discovery ${discoveryId} not found`);

  try {
    const report = await draftReport(row.profile);
    await saveDiscoveryReport(db, discoveryId, report, DISCOVERY_MODEL);
  } catch (err) {
    await releaseDiscoveryAnalysis(db, discoveryId);
    throw err;
  }
}

/**
 * Canonical brief name for a recommendation — also how the UI and the accept
 * action recognize "this rec already became a brief". The generation is part
 * of the name because `model` no longer carries it: without it a Yaris XP90
 * and a Yaris XP130 collide on one name and the second never gets its brief.
 */
export function briefNameForRecommendation(
  rec: Pick<ModelRecommendation, "make" | "model" | "generation">,
): string {
  const gen = rec.generation ? ` (${rec.generation})` : "";
  return `Descubrimiento: ${rec.make} ${rec.model}${gen}`;
}

/**
 * A recommendation becomes a hunting brief: recommendation narrows the what,
 * profile caps the money. Location defaults are editable in /briefs later.
 */
export function recommendationToBrief(
  profile: DiscoveryProfile,
  rec: ModelRecommendation,
): { name: string; criteria: BriefCriteria; hardLimits: HardLimits } {
  const maxPriceEur = Math.min(profile.budgetEur, rec.priceBandEur.max);
  const criteria: BriefCriteria = {
    vehicles: [
      { make: rec.make, model: rec.model, ...(rec.generation ? { generations: [rec.generation] } : {}) },
    ],
    yearMin: rec.yearMin,
    yearMax: rec.yearMax,
    targetPriceEur: rec.priceBandEur.min,
    fuel: profile.fuelPreference?.length ? profile.fuelPreference : undefined,
    gearbox:
      profile.gearbox && profile.gearbox !== "any" ? [profile.gearbox] : undefined,
    location: { lat: 40.4168, lon: -3.7038, radiusKm: 200 },
    riskTolerance: "medium",
    sellerPreference: "prefer_private",
    notes: [...rec.versions.map((v) => `Buscar versión: ${v}`), ...rec.watchouts],
  };
  return {
    name: briefNameForRecommendation(rec),
    criteria,
    hardLimits: { maxPriceEur, nonNegotiables: ["ITV en vigor"] },
  };
}
