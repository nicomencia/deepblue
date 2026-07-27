"use server";

import { events, modelDossiers, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/db";
import { buildDossier } from "../../lib/dossier-builder";
import { reevaluateModelLeads } from "../../lib/reevaluate";

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

export async function generateDossier(formData: FormData): Promise<void> {
  const db = await getDb();
  const userId = await resolveUserId();

  const make = String(formData.get("make") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();
  const generation = String(formData.get("generation") ?? "").trim() || undefined;
  if (!make || !model) throw new Error("marca y modelo son obligatorios");

  await buildDossier(db, { make, model, generation }, userId);
  revalidatePath("/dossiers");
}

/** Flip a dossier's live state and land the change on verdicts immediately. */
async function setDossierState(
  id: string,
  patch: { reviewedAt?: Date; disabledAt: Date | null },
  eventType: "dossier_approved" | "dossier_disabled" | "dossier_enabled",
): Promise<void> {
  const db = await getDb();

  const [dossier] = await db
    .update(modelDossiers)
    .set(patch)
    .where(eq(modelDossiers.id, id))
    .returning();
  if (!dossier) throw new Error(`dossier ${id} not found`);

  const reevaluated = await reevaluateModelLeads(db, dossier.make, dossier.model);

  await db.insert(events).values({
    userId: await resolveUserId(),
    type: eventType,
    payload: {
      dossierId: dossier.id,
      make: dossier.make,
      model: dossier.model,
      version: dossier.version,
      reevaluated,
    },
  });

  revalidatePath("/dossiers");
  revalidatePath("/");
}

/** Legacy drafts (pre-auto-approval) can still be approved by hand. */
export async function approveDossier(formData: FormData): Promise<void> {
  await setDossierState(
    String(formData.get("id") ?? ""),
    { reviewedAt: new Date(), disabledAt: null },
    "dossier_approved",
  );
}

/**
 * Review is opt-out since auto-approval (2026-07-14): disabling pulls the
 * dossier out of every verdict immediately (getDossier skips disabled rows;
 * an older live version, if any, takes over).
 */
export async function disableDossier(formData: FormData): Promise<void> {
  await setDossierState(
    String(formData.get("id") ?? ""),
    { disabledAt: new Date() },
    "dossier_disabled",
  );
}

/** Undo for disable. */
export async function enableDossier(formData: FormData): Promise<void> {
  await setDossierState(
    String(formData.get("id") ?? ""),
    { disabledAt: null },
    "dossier_enabled",
  );
}

/**
 * Permanent delete, draft or in use. There is no undo: the research is gone
 * and getting it back costs another run.
 *
 * Previously this only touched drafts (`isNull(reviewedAt)`), so asking to
 * delete a live dossier silently deleted nothing and re-rendered unchanged.
 * Deleting for real has two consequences the draft path never had, and both
 * are handled here rather than left to surprise:
 *
 *  - verdicts built on it are now wrong, so the model's leads are re-evaluated
 *    immediately (same as disabling). Grades will move — that is the point;
 *  - `findUncoveredHunts` will see the model as uncovered again, and if any
 *    active or paused brief still hunts it the scheduler's retry lane
 *    researches it on its own. Deleting a dossier for a car you are still
 *    hunting therefore SPENDS MONEY unless the brief goes too. The confirm
 *    text says so; disabling is the free way to silence one.
 *
 * Per-lead `findings` reference dossier issues by title, so they are orphaned
 * rather than deleted: if a rebuilt dossier names the same issue, the user's
 * confirmations apply again instead of having to be re-entered.
 */
export async function deleteDossier(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");

  const [dossier] = await db
    .delete(modelDossiers)
    .where(eq(modelDossiers.id, id))
    .returning();
  if (!dossier) throw new Error(`dossier ${id} not found`);

  const reevaluated = await reevaluateModelLeads(db, dossier.make, dossier.model);

  await db.insert(events).values({
    userId: await resolveUserId(),
    type: "dossier_deleted",
    payload: {
      dossierId: dossier.id,
      make: dossier.make,
      model: dossier.model,
      generation: dossier.content.generation,
      version: dossier.version,
      wasLive: dossier.reviewedAt !== null && dossier.disabledAt === null,
      issues: dossier.content.knownIssues.length,
      reevaluated,
    },
  });

  revalidatePath("/dossiers");
  revalidatePath("/");
}
