"use server";

import type { BriefCriteria, HardLimits } from "@deepblue/core";
import { briefs, events, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteBriefCascade } from "../../lib/brief-admin";
import { getDb } from "../../lib/db";
import { reevaluateBriefLeads } from "../../lib/reevaluate";

const num = (v: FormDataEntryValue | null): number | undefined => {
  const n = Number(String(v ?? "").replace(/[.\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const lines = (v: FormDataEntryValue | null): string[] =>
  String(v ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const fuelSchema = z.array(z.enum(["gasoline", "diesel", "hybrid", "electric"]));
const gearboxSchema = z.array(z.enum(["manual", "automatic"]));
const riskSchema = z.enum(["low", "medium", "high"]).catch("medium");
const sellerPrefSchema = z.enum(["any", "prefer_private"]).catch("any");

export async function createBrief(formData: FormData): Promise<void> {
  const db = await getDb();

  // Single-user phase: everything belongs to the dev user (Firebase Auth later).
  let [user] = await db.select().from(users).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email: process.env.DEV_USER_EMAIL ?? "nicomencia4@gmail.com" })
      .returning();
  }
  if (!user) throw new Error("could not resolve user");

  const make = String(formData.get("make") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();
  const maxPriceEur = num(formData.get("maxPriceEur"));
  if (!make || !model || !maxPriceEur) {
    throw new Error("marca, modelo y precio máximo son obligatorios");
  }

  const criteria: BriefCriteria = {
    vehicles: [{ make, model }],
    yearMin: num(formData.get("yearMin")),
    yearMax: num(formData.get("yearMax")),
    kmMax: num(formData.get("kmMax")),
    targetPriceEur: num(formData.get("targetPriceEur")),
    fuel: fuelSchema.catch([]).parse(formData.getAll("fuel").map(String)) || undefined,
    gearbox: gearboxSchema.catch([]).parse(formData.getAll("gearbox").map(String)) || undefined,
    location: {
      lat: Number(formData.get("lat") ?? 40.4168),
      lon: Number(formData.get("lon") ?? -3.7038),
      radiusKm: num(formData.get("radiusKm")) ?? 100,
    },
    riskTolerance: riskSchema.parse(String(formData.get("riskTolerance") ?? "medium")),
    sellerPreference: sellerPrefSchema.parse(String(formData.get("sellerPreference") ?? "any")),
    notes: lines(formData.get("notes")),
  };
  if (criteria.fuel?.length === 0) delete criteria.fuel;
  if (criteria.gearbox?.length === 0) delete criteria.gearbox;

  const hardLimits: HardLimits = {
    maxPriceEur,
    nonNegotiables: lines(formData.get("nonNegotiables")),
    ...(formData.get("noRhd") ? { noRhd: true } : {}),
    ...(formData.get("requireSpanishPlates") ? { requireSpanishPlates: true } : {}),
  };

  const name =
    String(formData.get("name") ?? "").trim() || `${make} ${model} hasta ${maxPriceEur} €`;

  await db.insert(briefs).values({ userId: user.id, name, criteria, hardLimits });
  revalidatePath("/briefs");
}

export async function setBriefStatus(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  const status = z
    .enum(["active", "paused", "fulfilled", "archived"])
    .parse(String(formData.get("status") ?? ""));
  await db.update(briefs).set({ status }).where(eq(briefs.id, id));
  revalidatePath("/briefs");
}

/**
 * Toggle an import hard limit (noRhd / requireSpanishPlates) on an existing
 * brief, then re-evaluate its shortlisted leads so the filter bites now —
 * newly-vetoed leads die (rhd_not_accepted / foreign_plates_not_accepted).
 */
export async function toggleBriefLimit(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  const field = z.enum(["noRhd", "requireSpanishPlates"]).parse(String(formData.get("field") ?? ""));

  const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
  if (!brief) throw new Error(`brief ${id} not found`);

  const hardLimits = { ...brief.hardLimits };
  if (hardLimits[field]) delete hardLimits[field];
  else hardLimits[field] = true;
  await db.update(briefs).set({ hardLimits }).where(eq(briefs.id, id));

  const reevaluated = await reevaluateBriefLeads(db, id);
  await db.insert(events).values({
    userId: brief.userId,
    type: "brief_limits_changed",
    payload: { briefId: id, field, enabled: hardLimits[field] === true, reevaluated },
  });

  revalidatePath("/briefs");
  revalidatePath("/");
}

/**
 * Hard delete: the brief, its leads and their history go; the listings stay
 * (global corpus). The UI asks for confirmation before submitting this.
 */
export async function deleteBrief(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");

  const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
  if (!brief) return;

  const deleted = await deleteBriefCascade(db, id);
  await db.insert(events).values({
    userId: brief.userId,
    type: "brief_deleted",
    payload: { briefId: id, name: brief.name, ...deleted },
  });

  revalidatePath("/briefs");
  revalidatePath("/discovery");
  revalidatePath("/");
}
