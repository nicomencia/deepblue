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
  BODY_STYLES,
  discoveryResearchSchema,
  isDrivetrain,
  parseDiscoveryReport,
  type BodyStyle,
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
import { fetchWikipediaPhoto } from "./wikipedia-photo";

const MAX_SEARCHES = 12;
const MAX_TURNS = 6;
/** Gap between photo lookups. Generous on purpose — see withPhotos(). */
const PHOTO_PACE_MS = 2_000;

/**
 * How much detail a recommendation has to carry to be worth reading.
 *
 * These counts used to be nowhere: the schema arrays have no bounds and the
 * prompt described each field's SHAPE but never its SIZE — "whyFits" wasn't
 * mentioned at all. So depth was model whim, and it drifted run to run on an
 * unchanged model (5+4 bullets → 4+4 → 3+3 over 27/07). Same writing quality
 * each time, ~78 chars a line; simply fewer lines.
 *
 * Deliberately NOT a schema `.min()`. Rejecting a thin report would throw away
 * minutes of paid web research over a presentation preference — the veto would
 * cost more than the defect. The prompt asks for these counts and
 * `discovery_report` records how many came back short, so the drift is visible
 * instead of silent.
 */
/**
 * Not uniform, because the four fields do different jobs. "whyFits" is the
 * ONLY one that answers the question this page exists to answer — cuál de
 * estos modelos elijo — so it keeps its depth. The other three are handoffs:
 * "versions"/"avoidVersions" become the brief's search terms and the
 * dossier deepens "watchouts" per unit later. Spending prose on them here
 * buries the comparison under detail the user can't act on yet.
 */
const DEPTH = {
  versions: { min: 2, max: 2 },
  avoidVersions: { min: 1, max: 2 },
  whyFits: { min: 4, max: 5 },
  watchouts: { min: 3, max: 3 },
} as const;

const span = (f: keyof typeof DEPTH): string =>
  DEPTH[f].min === DEPTH[f].max ? `${DEPTH[f].min}` : `${DEPTH[f].min}-${DEPTH[f].max}`;

/** Recommendations that came back under the asked-for depth. Telemetry only. */
export function thinRecommendations(report: DiscoveryReport): number {
  const fields = Object.keys(DEPTH) as Array<keyof typeof DEPTH>;
  return report.recommendations.filter((rec) =>
    fields.some((f) => rec[f].length < DEPTH[f].min),
  ).length;
}

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
  "generation" y los años en "yearMin"/"yearMax".
- "generation": UNA sola, el código a secas ("XP90", "GE", "VII"). Dos
  generaciones son dos coches distintos, con fiabilidad y precio distintos: si
  ambas te valen, elige la que de verdad recomiendas y ajusta los años a ESA.
  Nada de "GD (2006-2008) y GE (2009-2015)" — eso no es una recomendación.
- "bodyStyle": la carrocería con la que ESE coche se vendió en España, en el
  vocabulario de la lista (hatchback, sedan, estate, coupe, convertible,
  roadster, MPV, SUV, pickup, van). "hatchback" = 3 o 5 puertas con portón
  trasero, e incluye los utilitarios altos tipo Jazz o Meriva: reserva "MPV"
  para monovolúmenes de verdad (Zafira, Picasso). Un Yaris o un Corsa son
  "hatchback" aunque otros mercados tuvieran berlina; un MX-5, "convertible".
  Sirve para elegir la foto correcta: en la duda, la versión mayoritaria aquí.
- "drivetrain": "4x2" o "4x4" cuando en ese modelo exista la elección — y
  elígela tú, no la dejes abierta. En el mismo modelo y año son miles de euros
  de diferencia, así que "un Tucson" no es una recomendación hasta que dice
  qué Tucson. Decide con el perfil delante: el 4x4 tracciona mejor en nieve,
  barro o rampas y suele traer mejor equipamiento, a cambio de más peso, algo
  más de consumo, otra transmisión que mantener y bastante más precio. Si el
  comprador no va a salir del asfalto, el 4x2 es la respuesta honesta y lo
  dices en "whyFits"; si sí, justifica el sobreprecio ahí mismo.
- Esta pantalla sirve para UNA cosa: que el comprador elija entre los modelos
  que le propones. Todo lo que no le ayude a comparar sobra aquí, porque el
  programa ya lo trabaja en el paso siguiente (la búsqueda hereda "versions" y
  el dossier profundiza en "watchouts" unidad por unidad).
- "headline": 3-4 frases, y aquí SÍ te extiendes — es lo primero que lee y
  enmarca todo lo demás. Cuenta cómo has leído su perfil, qué criterio has
  usado para cortar (por qué gasolina y no diésel, por qué ese rango de años,
  qué le compra de verdad su presupuesto hoy) y qué tienen en común los modelos
  que le propones. Una sola frase enumerando los coches NO vale: eso ya lo ve
  en las tarjetas.
- Por eso el peso va en "whyFits": ${span("whyFits")} líneas, y son las únicas que pueden
  extenderse. Cada una ata el modelo a algo que el comprador ha dicho en su
  perfil (uso, presupuesto, prioridades, etiqueta) y explica por qué gana a las
  otras opciones, no solo por qué está bien.
- Las otras tres van CORTAS, de apunte, no de explicación: ${span("versions")} líneas en
  "versions", ${span("avoidVersions")} en "avoidVersions" y ${span("watchouts")} en "watchouts". Media
  línea cada una, dato concreto y punto — motor, potencia, cambio y el motivo
  en tres palabras ("1.4 D-4D: FAP en ciudad"). Nada de párrafos.
- "priceBandEur": horquilla realista HOY en el mercado español de segunda mano
  para la configuración recomendada, coherente con el presupuesto del perfil.
- "watchouts": puntos débiles del modelo que se puedan comprobar en una visita.
- "discarded": los modelos que este comprador esperaría ver y por qué no entran
  (ej. "Mini Cooper S R56: mismo motor Prince con peor acceso a mecánica barata").
- Cada recomendación lleva al menos una URL real encontrada en tus búsquedas; no
  inventes fuentes. Pocas recomendaciones bien fundadas valen más que muchas.
- Todos los textos visibles en español.
${constraintRules(profile)}`;
}

/**
 * The profile's hard constraints spelled out as rules. They are already in the
 * JSON above, but a recommendation that violates them is worthless: it becomes
 * a brief that inherits the same limits and then kills or downgrades every ad
 * it finds. Naming them costs a few tokens and saves a whole research run.
 */
function constraintRules(profile: DiscoveryProfile): string {
  const rules: string[] = [];
  if (profile.yearMin !== undefined || profile.yearMax !== undefined) {
    rules.push(
      `- SOLO generaciones que se vendan dentro de ${profile.yearMin ?? "…"}–${profile.yearMax ?? "hoy"}: ` +
        "el rango de años del comprador es un filtro real, y una recomendación fuera de él no le sirve. " +
        "Ajusta 'yearMin'/'yearMax' de cada recomendación a la intersección.",
    );
  }
  if (profile.kmMax !== undefined) {
    rules.push(
      `- Descarta modelos cuya oferta a este precio esté casi toda por encima de ${profile.kmMax.toLocaleString("es-ES")} km, ` +
        "y dilo en 'discarded' si es el motivo.",
    );
  }
  if (profile.ecoLabelMin) {
    rules.push(
      `- Etiqueta DGT mínima ${profile.ecoLabelMin}: comprueba que la motorización y el año la consiguen ` +
        "(un diésel anterior a 2006 o un gasolina anterior a 2000 no tienen etiqueta y quedan fuera de las ZBE). " +
        "Si un modelo solo la alcanza en ciertos años o motores, dilo en 'versions'.",
    );
  }
  if (profile.noRhd) rules.push("- Nada de volante a la derecha (importaciones de UK).");
  if (profile.requireSpanishPlates) {
    rules.push("- Solo coches ya matriculados en España: nada que exija rematriculación.");
  }
  return rules.length ? `\nRestricciones duras del comprador:\n${rules.join("\n")}` : "";
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
        output_config: { format: zodOutputFormat(discoveryResearchSchema) },
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

/**
 * Does this URL actually serve an image, or does it just look like one?
 *
 * Research invents Commons filenames that are perfectly plausible — real make,
 * real generation code, real naming convention — and simply do not exist. On
 * 2026-07-28 Opus 5 supplied all five and all five were 404s that rendered as
 * broken images. A URL shape check can't catch that; only asking can.
 *
 * A definitive "no" (404, or a page instead of a file — Commons answers a
 * missing file with 42 KB of HTML) means drop it. Anything else — timeout,
 * network down, rate limit — returns true and keeps the URL: discarding a good
 * photo because the check itself failed would be the worse error.
 */
async function photoResolves(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "deepblue/1.0 (personal car-hunting agent)" },
    });
    // Only a definitive "this file does not exist" condemns a URL. 429 and 5xx
    // mean Wikimedia is busy or throttling us — treating those as "invented"
    // would delete good photos precisely during a rate limit, which is when
    // the ladder can't find replacements either. Verified live 2026-07-28:
    // hammering the API to check five URLs earned a 429 on everything after.
    if (res.status === 429 || res.status >= 500) return true;
    if (!res.ok) return false;
    return (res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
  } catch {
    return true; // couldn't ask — don't punish the URL for it
  }
}

/**
 * Give every recommendation a real, era-correct photo BEFORE it is stored.
 *
 * Research supplies one for some models and skips the rest (1 of 4 on
 * 2026-07-27 — it has 12 searches and spends them on prices). Resolving the
 * gaps at render time made the photos flicker: Wikimedia rate-limits bursts,
 * so a card had a photo on one load and not the next. Doing it once here fixes
 * both — the URL is part of the stored report from the moment it exists.
 *
 * A supplied URL is VERIFIED, not trusted: the model's own photos are the ones
 * most likely to be invented, and trusting them meant our resolver never ran
 * on exactly the recommendations that needed it most. Parse, don't trust —
 * same rule as every other LLM boundary here.
 *
 * Deliberately sequential with a pause: this runs after an analysis that took
 * minutes, so a few seconds spent NOT tripping the rate limit is free, and a
 * burst is exactly what makes the lookups fail. Never throws — a report
 * without photos is still a good report.
 */
async function withPhotos(report: DiscoveryReport): Promise<DiscoveryReport> {
  const recommendations = [...report.recommendations];
  for (let i = 0; i < recommendations.length; i++) {
    const rec = recommendations[i];
    if (!rec) continue;
    if (rec.imageUrl) {
      if (await photoResolves(rec.imageUrl)) continue;
      // Invented. Fall through and resolve it properly.
      recommendations[i] = { ...rec, imageUrl: undefined };
    }
    try {
      const url = await fetchWikipediaPhoto(
        rec.make,
        rec.model,
        rec.generation,
        { yearMin: rec.yearMin, yearMax: rec.yearMax },
        rec.bodyStyle,
      );
      if (url) recommendations[i] = { ...rec, imageUrl: url };
    } catch {
      // Offline, rate-limited, slow: leave this one without a photo.
    }
    // 400 ms was still a burst: five recommendations, each firing several
    // lookups, earned a 429 partway through and the tail came back empty
    // (live, 2026-07-28). This runs after an analysis that took MINUTES —
    // spending ten more seconds to get every photo right the first time is
    // the cheapest trade in the whole flow.
    await new Promise((r) => setTimeout(r, PHOTO_PACE_MS));
  }
  return { ...report, recommendations };
}

/**
 * Repair the photos of an already-stored report: fills the missing ones and
 * replaces any that no longer resolve. Free and idempotent; returns how many
 * recommendations changed photo.
 *
 * Counts how many URLs CHANGED, not how many exist. Five invented URLs
 * replaced by five real ones leaves the count identical, and comparing counts
 * would call that "nothing to do" and never save the repair.
 */
export async function backfillDiscoveryPhotos(
  db: Db,
  discoveryId: string,
  /**
   * Re-resolve photos that already work. Verification only catches URLs that
   * 404 — a photo can be perfectly real and still be the wrong car (a Yaris
   * SEDAN, a previous-generation Jazz), and those never heal on their own.
   * After a fix to the ranking, this is how stored reports get the benefit
   * without paying for a new analysis.
   */
  force = false,
  /**
   * Retrofit a body onto recommendations stored before `bodyStyle` existed.
   * Reports written earlier have no way to say "hatchback", and without it the
   * resolver reads a generation's mixed parent category — which is how the
   * Yaris kept coming back a sedan. Only fills the gap; never overwrites a
   * body the report already states.
   */
  assumeBody?: BodyStyle,
): Promise<number> {
  const [row] = await db
    .select()
    .from(discoveries)
    .where(eq(discoveries.id, discoveryId))
    .limit(1);
  if (!row?.report) return 0;

  const before = row.report.recommendations.map((r) => r.imageUrl);
  const source =
    force || assumeBody
      ? {
          ...row.report,
          recommendations: row.report.recommendations.map((r) => ({
            ...r,
            bodyStyle: r.bodyStyle ?? assumeBody,
            imageUrl: force ? undefined : r.imageUrl,
          })),
        }
      : row.report;
  const report = await withPhotos(source);
  const changed = report.recommendations.filter((r, i) => r.imageUrl !== before[i]).length;
  if (changed === 0) return 0;

  await db.update(discoveries).set({ report }).where(eq(discoveries.id, discoveryId));
  return changed;
}

/** Store a validated report. Shared by the API lane and the manual import lane. */
export async function saveDiscoveryReport(
  db: Db,
  discoveryId: string,
  rawReport: DiscoveryReport,
  source: string,
): Promise<void> {
  const report = await withPhotos(rawReport);
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
      // Depth is asked for in the prompt, not enforced by the schema (see
      // DEPTH) — this is how we find out when the model quietly stops
      // honouring it, instead of noticing months later that reports read thin.
      thin: thinRecommendations(report),
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
    // A failure here has already cost minutes of paid web research, and the
    // only trace used to be a red line in the browser that vanished on the
    // next render — the button went clickable again and nobody could say why
    // (live, 2026-07-28: a 65 s run lost to a schema mismatch, undiagnosable
    // after the fact). Now it survives in the log and in the event stream.
    console.error(`[discovery] análisis ${discoveryId} falló:`, err);
    await db.insert(events).values({
      userId: row.userId,
      type: "discovery_analysis_failed",
      payload: { discoveryId, model: DISCOVERY_MODEL, error: String(err).slice(0, 500) },
    });
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

  // The two year bands mean different things and both must hold: the
  // recommendation's is the generation it is proposing, the profile's is what
  // the user will actually buy. Intersect — taking either alone would either
  // hunt outside the generation or ignore what the user asked for.
  const bounds = (a: number | undefined, b: number | undefined, pick: (x: number, y: number) => number) =>
    a !== undefined && b !== undefined ? pick(a, b) : (a ?? b);

  const criteria: BriefCriteria = {
    vehicles: [
      { make: rec.make, model: rec.model, ...(rec.generation ? { generations: [rec.generation] } : {}) },
    ],
    yearMin: bounds(rec.yearMin, profile.yearMin, Math.max),
    yearMax: bounds(rec.yearMax, profile.yearMax, Math.min),
    kmMax: profile.kmMax,
    targetPriceEur: rec.priceBandEur.min,
    fuel: profile.fuelPreference?.length ? profile.fuelPreference : undefined,
    gearbox:
      profile.gearbox && profile.gearbox !== "any" ? [profile.gearbox] : undefined,
    // The recommendation picked a drivetrain, so the hunt inherits it — this
    // is the whole point of asking for it. Without this the search mixes 4x2
    // and 4x4 again and the recommendation's choice dies on the page it
    // was made on.
    drivetrain: isDrivetrain(rec.drivetrain) ? [rec.drivetrain] : undefined,
    // No location = no radius check = all of Spain, which is the default now.
    // The old hardcoded Madrid ±200 km silently narrowed every hunt created
    // from a discovery to one third of the country.
    location: profile.location,
    riskTolerance: profile.riskTolerance ?? "medium",
    sellerPreference: profile.sellerPreference ?? "prefer_private",
    notes: [
      ...rec.versions.map((v) => `Buscar versión: ${v}`),
      ...rec.watchouts,
      // No ecoLabel field on BriefCriteria yet, so it rides as a stated
      // condition rather than being silently dropped between the two.
      ...(profile.ecoLabelMin ? [`Etiqueta DGT mínima: ${profile.ecoLabelMin}`] : []),
    ],
  };
  return {
    name: briefNameForRecommendation(rec),
    criteria,
    hardLimits: {
      maxPriceEur,
      nonNegotiables: ["ITV en vigor"],
      ...(profile.noRhd ? { noRhd: true } : {}),
      ...(profile.requireSpanishPlates ? { requireSpanishPlates: true } : {}),
    },
  };
}
