"use server";

import { discoveryProfileSchema, type DiscoveryProfile } from "@deepblue/core";
import { briefs, discoveries, events, users } from "@deepblue/db";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError, actionOk, type ActionResult } from "../../lib/action-result";
import { startBriefHunt } from "../../lib/brief-hunt";
import { getDb } from "../../lib/db";
import {
  buildDiscoveryReport,
  claimDiscoveryAnalysis,
  recommendationToBrief,
} from "../../lib/discovery";
import { isLlmConfigured } from "../../lib/llm";

// Single-user phase: everything belongs to the dev user (Firebase Auth later).
async function resolveUserId(): Promise<string> {
  const db = await getDb();
  let [user] = await db.select().from(users).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email: process.env.DEV_USER_EMAIL ?? "nicomencia4@gmail.com" })
      .returning();
  }
  if (!user) throw new Error("could not resolve user");
  return user.id;
}

const num = (v: FormDataEntryValue | null): number | undefined => {
  const n = Number(String(v ?? "").replace(/[.\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const lines = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Returns its outcome instead of throwing: budget and usage are typed by hand,
 * and a recoverable typo ("ocho mil") deserves a line under the button, not
 * Next's error overlay. The message names what happens next — the profile is
 * created `pending` and does nothing until it is analysed.
 */
export async function createDiscovery(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const db = await getDb();
  const userId = await resolveUserId();

  const budgetEur = num(formData.get("budgetEur"));
  const usage = String(formData.get("usage") ?? "").trim();
  if (!budgetEur) {
    return actionError("Indica un presupuesto en números, por ejemplo 8.000");
  }
  if (!usage) return actionError("Indica para qué quieres el coche");

  const profile: DiscoveryProfile = discoveryProfileSchema.parse({
    budgetEur,
    usage,
    kmPerYear: num(formData.get("kmPerYear")),
    seatsMin: num(formData.get("seatsMin")),
    fuelPreference: z
      .array(z.enum(["gasoline", "diesel", "hybrid", "electric"]))
      .catch([])
      .parse(formData.getAll("fuel").map(String)),
    gearbox: z
      .enum(["manual", "automatic", "any"])
      .catch("any")
      .parse(String(formData.get("gearbox") ?? "any")),
    priorities: lines(formData.get("priorities")),
    mustHaves: lines(formData.get("mustHaves")),
    dealBreakers: lines(formData.get("dealBreakers")),
    notes: String(formData.get("notes") ?? "").trim() || undefined,
  });
  if (profile.fuelPreference?.length === 0) delete profile.fuelPreference;

  await db.insert(discoveries).values({ userId, profile });
  await db.insert(events).values({
    userId,
    type: "discovery_created",
    payload: { budgetEur, usage },
  });
  revalidatePath("/discovery");
  return actionOk(
    isLlmConfigured()
      ? "Perfil creado. Pulsa «Analizar con IA» en la ficha de abajo para recibir modelos concretos."
      : "Perfil creado. Sin API key el análisis se pide desde Claude Code; la ficha está abajo.",
  );
}

/**
 * API lane only: gated on the key, like dossier generation.
 *
 * The claim comes first and is the whole point. Research is the most expensive
 * action in the product, the pending spinner lives only in the browser, and a
 * refresh used to hand back a live button — clicking it bought a second full
 * run (it happened: discovery 61c226a6 carries two `discovery_report` events
 * from the same model on 2026-07-27, and the second overwrote the first). The
 * loser of the race is told so instead of quietly paying again.
 */
export async function analyzeDiscovery(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  if (!isLlmConfigured()) return actionError("ANTHROPIC_API_KEY no configurada");
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  if (!id) return actionError("id obligatorio");

  if (!(await claimDiscoveryAnalysis(db, id))) {
    revalidatePath("/discovery");
    return actionError("Ya se está analizando este perfil — tarda unos minutos.");
  }
  revalidatePath("/discovery");

  try {
    await buildDiscoveryReport(db, id);
  } catch (err) {
    revalidatePath("/discovery");
    return actionError(`El análisis falló: ${String(err).slice(0, 200)}`);
  }
  revalidatePath("/discovery");
  return actionOk("Análisis listo: abajo tienes los modelos recomendados.");
}

/** One click: a recommendation becomes an active hunting brief. */
export async function createBriefFromRecommendation(formData: FormData): Promise<void> {
  const db = await getDb();
  const userId = await resolveUserId();

  const discoveryId = String(formData.get("discoveryId") ?? "");
  const index = Number(formData.get("index") ?? -1);
  const [row] = await db
    .select()
    .from(discoveries)
    .where(eq(discoveries.id, discoveryId))
    .limit(1);
  const rec = row?.report?.recommendations[index];
  if (!row || !rec) throw new Error("recomendación no encontrada");

  const draft = recommendationToBrief(row.profile, rec);

  // Idempotent: a double click (or re-click) must not spawn a second brief.
  // A live brief with this rec's canonical name already answers the intent.
  const [existing] = await db
    .select({ id: briefs.id })
    .from(briefs)
    .where(
      and(eq(briefs.userId, userId), eq(briefs.name, draft.name), ne(briefs.status, "archived")),
    )
    .limit(1);
  if (!existing) {
    const [created] = await db
      .insert(briefs)
      .values({ userId, ...draft })
      .returning({ id: briefs.id });

    await db.insert(events).values({
      userId,
      type: "brief_from_discovery",
      payload: { discoveryId, briefId: created?.id, make: rec.make, model: rec.model },
    });

    // Same zero-click chain as manual brief creation: dossier-first, then
    // sweep — the recommendation's year band scopes the coverage check.
    await startBriefHunt(db, userId, {
      make: rec.make,
      model: rec.model,
      generation: rec.generation,
      yearMin: rec.yearMin,
      yearMax: rec.yearMax,
    });
  }
  revalidatePath("/discovery");
  revalidatePath("/briefs");
  revalidatePath("/");
}

export async function archiveDiscovery(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  await db.update(discoveries).set({ status: "archived" }).where(eq(discoveries.id, id));
  revalidatePath("/discovery");
}
