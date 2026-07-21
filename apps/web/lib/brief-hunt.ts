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
import { briefs, events, modelDossiers, type Db } from "@deepblue/db";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { buildDossier, isDossierBuilding } from "./dossier-builder";
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

export interface UncoveredHunt extends HuntVehicle {
  userId: string;
}

/**
 * Every hunt (active brief, or paused "Seguimiento" from adoption) whose
 * model+generation no live dossier covers — recomputed from current state, so
 * it self-heals: a failed build, a server restart mid-research, or a dossier
 * disabled later all resurface here. Shared by the /dossiers page (display)
 * and the retry lane (action).
 */
export async function findUncoveredHunts(db: Db): Promise<UncoveredHunt[]> {
  const [huntBriefs, dossierRows] = await Promise.all([
    db.select().from(briefs).where(inArray(briefs.status, ["active", "paused"])),
    db
      .select({ make: modelDossiers.make, model: modelDossiers.model, content: modelDossiers.content })
      .from(modelDossiers)
      .where(isNull(modelDossiers.disabledAt)),
  ]);

  const isCovered = (make: string, model: string, yearMin?: number, yearMax?: number) =>
    dossierRows.some(
      (d) =>
        d.make.toLowerCase() === make.toLowerCase() &&
        dossierCoversModel(d.model, model) &&
        dossierCoversYears(d.content.generation, yearMin, yearMax),
    );

  const missing = new Map<string, UncoveredHunt>();
  for (const brief of huntBriefs) {
    for (const v of brief.criteria.vehicles) {
      const generation = v.generations?.[0];
      const span = generationYearSpan(generation);
      const yearMin = brief.criteria.yearMin ?? span?.yearMin;
      const yearMax = brief.criteria.yearMax ?? span?.yearMax;
      const key = `${v.make.toLowerCase()}|${v.model.toLowerCase()}|${generation ?? `${yearMin ?? ""}-${yearMax ?? ""}`}`;
      if (!isCovered(v.make, v.model, yearMin, yearMax) && !missing.has(key)) {
        missing.set(key, { userId: brief.userId, make: v.make, model: v.model, generation, yearMin, yearMax });
      }
    }
  }
  return [...missing.values()];
}

/** Retry cost guards: skip a model that failed within the hour (transient API
 * trouble deserves patience, not a metronome) or ≥3 times in 24 h (something
 * structural — surfacing in /dossiers beats burning research turns). */
const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const RETRY_DAILY_CEILING = 3;

export interface DossierRetryStats {
  pending: number;
  started?: string;
}

/**
 * Scheduler lane: pick ONE uncovered hunt whose build isn't running and isn't
 * throttled, and fire its research (fire-and-forget — research takes minutes,
 * ticks must not stack). One per tick drains a backlog steadily, cost-bounded.
 */
export async function retryPendingDossiers(db: Db): Promise<DossierRetryStats> {
  if (!isLlmConfigured()) return { pending: 0 };
  const pending = await findUncoveredHunts(db);

  for (const hunt of pending) {
    if (isDossierBuilding(hunt.make, hunt.model)) continue;

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failures = await db
      .select({ createdAt: events.createdAt })
      .from(events)
      .where(
        and(
          eq(events.type, "dossier_build_failed"),
          gte(events.createdAt, dayAgo),
          sql`lower(${events.payload}->>'make') = ${hunt.make.toLowerCase()}`,
          sql`lower(${events.payload}->>'model') = ${hunt.model.toLowerCase()}`,
        ),
      );
    const lastFail = failures.reduce<number>((max, f) => Math.max(max, f.createdAt.getTime()), 0);
    if (failures.length >= RETRY_DAILY_CEILING) continue;
    if (Date.now() - lastFail < RETRY_COOLDOWN_MS) continue;

    void buildDossier(
      db,
      { make: hunt.make, model: hunt.model, generation: hunt.generation },
      hunt.userId,
    ).catch(async (err: unknown) => {
      await db.insert(events).values({
        userId: hunt.userId,
        type: "dossier_build_failed",
        payload: { make: hunt.make, model: hunt.model, error: String(err).slice(0, 300) },
      });
    });
    return { pending: pending.length, started: `${hunt.make} ${hunt.model}` };
  }
  return { pending: pending.length };
}
