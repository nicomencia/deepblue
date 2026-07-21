/**
 * Hands-free hunt start for a just-created brief — the zero-click chain:
 *  - model+generation uncovered → research a dossier now (fire-and-forget);
 *    when it lands, insertDossier runs the rest itself: re-evaluate leads,
 *    targeted sweep, and the sweep's ingest triggers enrichment (keyLines).
 *  - covered → targeted sweep immediately, so the hunt starts the moment the
 *    search exists instead of at the next scheduler tick (~3 h away).
 * Coverage is generation-aware (dossierCoversYears): a gen-III dossier never
 * silences the need for a gen-I one.
 */

import { dossierCoversModel, dossierCoversYears, generationYearSpan } from "@deepblue/core";
import { events, modelDossiers, type Db } from "@deepblue/db";
import { and, isNull, sql } from "drizzle-orm";
import { buildDossier } from "./dossier-builder";
import { isLlmConfigured } from "./llm";
import { enqueueSweeps } from "./sweep";

export interface HuntVehicle {
  make: string;
  model: string;
  generation?: string;
  yearMin?: number;
  yearMax?: number;
}

export async function startBriefHunt(
  db: Db,
  userId: string,
  v: HuntVehicle,
): Promise<"sweeping" | "researching" | "waiting_manual_dossier"> {
  // Hunt window: explicit year bounds win; the generation label fills gaps.
  const span = generationYearSpan(v.generation);
  const yearMin = v.yearMin ?? span?.yearMin;
  const yearMax = v.yearMax ?? span?.yearMax;

  const rows = await db
    .select({ model: modelDossiers.model, content: modelDossiers.content })
    .from(modelDossiers)
    .where(
      and(
        sql`lower(${modelDossiers.make}) = ${v.make.toLowerCase()}`,
        isNull(modelDossiers.disabledAt),
      ),
    );
  const covered = rows.some(
    (d) =>
      dossierCoversModel(d.model, v.model) &&
      dossierCoversYears(d.content.generation, yearMin, yearMax),
  );

  if (covered) {
    await enqueueSweeps(db, { make: v.make, model: v.model });
    return "sweeping";
  }

  await db.insert(events).values({
    userId,
    type: "dossier_needed",
    payload: { make: v.make, model: v.model, generation: v.generation, reason: "brief_created" },
  });
  // Subscription lane: /dossiers keeps showing the card for the manual click.
  if (!isLlmConfigured()) return "waiting_manual_dossier";

  // Research takes minutes — never block the creating request. The build's
  // completion (insertDossier) carries the chain from there.
  void buildDossier(
    db,
    { make: v.make, model: v.model, generation: v.generation },
    userId,
  ).catch(async (err: unknown) => {
    await db.insert(events).values({
      userId,
      type: "dossier_build_failed",
      payload: { make: v.make, model: v.model, error: String(err).slice(0, 300) },
    });
  });
  return "researching";
}
