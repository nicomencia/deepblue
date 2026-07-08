"use server";

import { briefs, events, leads, listings, modelDossiers, users } from "@deepblue/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "../../lib/db";
import { buildDossier } from "../../lib/dossier-builder";
import { newEvalCaches, reevaluateLead } from "../../lib/reevaluate";

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

/**
 * Approval is the human-review gate: only from here on may this dossier
 * drive reliability claims. Every shortlisted lead on the model is
 * re-evaluated immediately so verdicts pick the new knowledge up.
 */
export async function approveDossier(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");

  const [dossier] = await db
    .update(modelDossiers)
    .set({ reviewedAt: new Date() })
    .where(eq(modelDossiers.id, id))
    .returning();
  if (!dossier) throw new Error(`dossier ${id} not found`);

  const make = dossier.make.toLowerCase();
  const model = dossier.model.toLowerCase();
  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(
      and(
        eq(leads.state, "shortlisted"),
        or(
          and(
            sql`lower(${listings.make}) = ${make}`,
            sql`lower(${listings.model}) = ${model}`,
          ),
          // Legacy rows without make/model columns: match on the title.
          and(
            sql`${listings.title} ilike ${"%" + make + "%"}`,
            sql`${listings.title} ilike ${"%" + model + "%"}`,
          ),
        ),
      ),
    );

  const caches = newEvalCaches();
  for (const row of rows) {
    await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
  }

  await db.insert(events).values({
    userId: await resolveUserId(),
    type: "dossier_approved",
    payload: {
      dossierId: dossier.id,
      make: dossier.make,
      model: dossier.model,
      version: dossier.version,
      reevaluated: rows.length,
    },
  });

  revalidatePath("/dossiers");
  revalidatePath("/");
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
