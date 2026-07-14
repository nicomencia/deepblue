"use server";

import { events, modelDossiers, users } from "@deepblue/db";
import { and, eq, isNull } from "drizzle-orm";
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

/** Drafts can be discarded; reviewed dossiers are knowledge in use — keep them. */
export async function deleteDossier(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  await db
    .delete(modelDossiers)
    .where(and(eq(modelDossiers.id, id), isNull(modelDossiers.reviewedAt)));
  revalidatePath("/dossiers");
}
