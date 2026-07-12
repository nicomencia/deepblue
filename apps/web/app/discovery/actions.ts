"use server";

import { discoveryProfileSchema, type DiscoveryProfile } from "@deepblue/core";
import { briefs, discoveries, events, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "../../lib/db";
import { buildDiscoveryReport, recommendationToBrief } from "../../lib/discovery";
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

export async function createDiscovery(formData: FormData): Promise<void> {
  const db = await getDb();
  const userId = await resolveUserId();

  const budgetEur = num(formData.get("budgetEur"));
  const usage = String(formData.get("usage") ?? "").trim();
  if (!budgetEur || !usage) throw new Error("presupuesto y uso son obligatorios");

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
}

/** API lane only: gated on the key, like dossier generation. */
export async function analyzeDiscovery(formData: FormData): Promise<void> {
  if (!isLlmConfigured()) throw new Error("ANTHROPIC_API_KEY no configurada");
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id obligatorio");
  await buildDiscoveryReport(db, id);
  revalidatePath("/discovery");
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
  const [created] = await db
    .insert(briefs)
    .values({ userId, ...draft })
    .returning({ id: briefs.id });

  await db.insert(events).values({
    userId,
    type: "brief_from_discovery",
    payload: { discoveryId, briefId: created?.id, make: rec.make, model: rec.model },
  });
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
