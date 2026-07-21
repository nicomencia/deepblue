/**
 * Automated model-dossier builder: Claude + web research → a source-cited
 * ModelDossier, live from the moment it's stored (auto-approved, 2026-07-14).
 * Review is opt-out: /dossiers can disable any dossier, which pulls it out of
 * verdicts immediately (getDossier skips disabled rows). PROJECT.md, Reliability.
 */

import { modelDossierSchema, type ModelDossier } from "@deepblue/core";
import { events, modelDossiers, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { DOSSIER_MODEL, getAnthropic, messageText } from "./llm";
import { reevaluateModelLeads } from "./reevaluate";
import { enqueueSweeps } from "./sweep";

export interface DossierRequest {
  make: string;
  model: string;
  /** e.g. "VII (2012–2019)" — narrows the research if the brief knows it. */
  generation?: string;
  engines?: string[];
}

const MAX_SEARCHES = 12;
/** Server tools may pause the turn; resend with progress appended, bounded. */
const MAX_TURNS = 6;

function prompt(req: DossierRequest): string {
  const scope = [
    `Marca y modelo: ${req.make} ${req.model}`,
    req.generation ? `Generación: ${req.generation}` : undefined,
    req.engines?.length ? `Motores de interés: ${req.engines.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return `Eres un mecánico experto en el mercado español de coches de segunda mano.
Investiga en la web los problemas de fiabilidad CONOCIDOS de este modelo y produce
un dossier estructurado para evaluar unidades concretas en venta:

${scope}

Reglas estrictas:
- Cada problema debe estar respaldado por al menos una URL que hayas encontrado
  realmente en tus búsquedas. NO inventes fuentes ni problemas: si no puedes
  respaldarlo, no lo incluyas. Un dossier corto y cierto vale más que uno largo.
- Cubre los problemas típicos de compra usada: motor, cambio (DSG/automático y
  manual), distribución (correa/cadena), consumo de aceite, electrónica, EGR/DPF
  en diésel, campañas de retirada (recalls).
- "applicability" define cuándo muerde cada problema: rangos de km y año, y los
  tokens canónicos fuel = "diesel" | "gasoline", gearbox = "automatic" | "manual",
  potencia en CV (powerCvMin/powerCvMax). Omite los campos que no restrinjan.
- "typicalRepairCostEur": horquilla realista en talleres españoles, en euros.
- "evidence": qué evidencia concreta descarta o confirma el problema en una unidad
  (facturas, libro de mantenimiento, prueba dinámica, lectura OBD...).
- "sellerQuestions": preguntas directas y coloquiales en español para el vendedor.
- "severity": minor | moderate | major | critical según coste y consecuencias.
- Todos los textos visibles (title, description, evidence, sellerQuestions,
  generalNotes) en español. "generation" con el formato "VII (2012–2019)":
  el rango de años entre paréntesis es OBLIGATORIO cuando investigas una
  generación concreta — el sistema elige el dossier de cada anuncio por ese
  rango ("presente" para generaciones aún en producción). Si el encargo nombra
  la generación de otra forma ("Primera", "Mk2"), tradúcela a este formato.
- En "make" y "model" usa exactamente: ${req.make} / ${req.model}.`;
}

/** One research turn; loops while the server pauses long tool interactions. */
async function draftWithResearch(req: DossierRequest): Promise<ModelDossier> {
  const client = getAnthropic();
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt(req) }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await client.messages
      .stream({
        model: DOSSIER_MODEL,
        max_tokens: 24_000,
        thinking: { type: "adaptive" },
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: MAX_SEARCHES }],
        output_config: { format: zodOutputFormat(modelDossierSchema) },
        messages,
      })
      .finalMessage();

    if (msg.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: msg.content }];
      continue;
    }
    // Trust boundary: LLM output must pass the domain schema before storage.
    return modelDossierSchema.parse(JSON.parse(messageText(msg)));
  }
  throw new Error(`la investigación del dossier no convergió en ${MAX_TURNS} turnos`);
}

export interface BuiltDossier {
  id: string;
  version: number;
  dossier: ModelDossier;
}

/**
 * Store a validated dossier and put it in use immediately, re-evaluating the
 * model's shortlisted leads so verdicts pick the knowledge up. Shared by the
 * API builder and the manual import lane (a Claude Code session drafting
 * dossiers on the user's subscription instead of per-token billing).
 */
export async function insertDossier(
  db: Db,
  dossier: ModelDossier,
  userId: string,
  source: string,
): Promise<BuiltDossier> {
  // Version scoped to make+model: "latest reviewed wins" stays unambiguous
  // even across generations/engine codes.
  const [row] = await db
    .select({ max: sql<number | null>`max(${modelDossiers.version})` })
    .from(modelDossiers)
    .where(
      sql`lower(${modelDossiers.make}) = ${dossier.make.toLowerCase()} and lower(${modelDossiers.model}) = ${dossier.model.toLowerCase()}`,
    );
  const version = (row?.max ?? 0) + 1;

  const [inserted] = await db
    .insert(modelDossiers)
    .values({
      make: dossier.make,
      model: dossier.model,
      generation: dossier.generation,
      version,
      content: dossier,
      reviewedAt: new Date(), // auto-approved: in use now, disable in /dossiers to revoke
    })
    .returning({ id: modelDossiers.id });
  if (!inserted) throw new Error("dossier insert returned no row");

  const reevaluated = await reevaluateModelLeads(db, dossier.make, dossier.model);

  // Fresh knowledge, fresh hunt: sweep the model's active briefs right away
  // instead of waiting for the next scheduler tick — a brief created together
  // with its dossier starts finding units the moment the knowledge lands.
  const swept = await enqueueSweeps(db, { make: dossier.make, model: dossier.model });

  await db.insert(events).values({
    userId,
    type: "dossier_created",
    payload: {
      dossierId: inserted.id,
      make: dossier.make,
      model: dossier.model,
      version,
      issues: dossier.knownIssues.length,
      sources: dossier.sources.length,
      source,
      reevaluated,
      swept,
    },
  });

  return { id: inserted.id, version, dossier };
}

// Research runs for minutes; auto-build (brief creation, adoption) and the
// manual /dossiers click can overlap on the same model — one build is enough.
const building = new Set<string>();

/** Pages render in this same process: show "investigando…" instead of a
 * button that would only throw the duplicate-build error. */
export function isDossierBuilding(make: string, model: string): boolean {
  return building.has(`${make}|${model}`.toLowerCase());
}

export async function buildDossier(
  db: Db,
  req: DossierRequest,
  userId: string,
): Promise<BuiltDossier> {
  const key = `${req.make}|${req.model}`.toLowerCase();
  if (building.has(key)) {
    throw new Error(`ya se está investigando ${req.make} ${req.model} — espera a que termine`);
  }
  building.add(key);
  try {
    const drafted = await draftWithResearch(req);
    // Canonical identity comes from the request, whatever the model echoed.
    const dossier: ModelDossier = { ...drafted, make: req.make, model: req.model };
    return await insertDossier(db, dossier, userId, DOSSIER_MODEL);
  } finally {
    building.delete(key);
  }
}
