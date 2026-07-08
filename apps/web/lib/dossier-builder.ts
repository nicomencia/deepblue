/**
 * Automated model-dossier builder: Claude + web research → a source-cited
 * ModelDossier draft, stored with reviewedAt = null. Drafts NEVER drive
 * reliability claims (getDossier only returns reviewed rows) — a human
 * approves each one in /dossiers first. See PROJECT.md, Reliability pillar.
 */

import { modelDossierSchema, type ModelDossier } from "@deepblue/core";
import { events, modelDossiers, type Db } from "@deepblue/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { DOSSIER_MODEL, getAnthropic, messageText } from "./llm";

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
  generalNotes) en español. "generation" con el formato "VII (2012–2019)".
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

export async function buildDossier(
  db: Db,
  req: DossierRequest,
  userId: string,
): Promise<BuiltDossier> {
  const dossier = await draftWithResearch(req);

  // Version scoped to make+model: "latest reviewed wins" stays unambiguous
  // even across generations/engine codes.
  const [row] = await db
    .select({ max: sql<number | null>`max(${modelDossiers.version})` })
    .from(modelDossiers)
    .where(
      sql`lower(${modelDossiers.make}) = ${req.make.toLowerCase()} and lower(${modelDossiers.model}) = ${req.model.toLowerCase()}`,
    );
  const version = (row?.max ?? 0) + 1;

  const [inserted] = await db
    .insert(modelDossiers)
    .values({
      make: req.make,
      model: req.model,
      generation: dossier.generation,
      version,
      content: dossier,
      reviewedAt: null, // draft: a human approves it in /dossiers before use
    })
    .returning({ id: modelDossiers.id });
  if (!inserted) throw new Error("dossier insert returned no row");

  await db.insert(events).values({
    userId,
    type: "dossier_drafted",
    payload: {
      dossierId: inserted.id,
      make: req.make,
      model: req.model,
      version,
      issues: dossier.knownIssues.length,
      sources: dossier.sources.length,
      model_id: DOSSIER_MODEL,
    },
  });

  return { id: inserted.id, version, dossier };
}
