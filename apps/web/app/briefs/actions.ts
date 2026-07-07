"use server";

import type { BriefCriteria, HardLimits } from "@deepblue/core";
import { briefs, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "../../lib/db";

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
    notes: lines(formData.get("notes")),
  };
  if (criteria.fuel?.length === 0) delete criteria.fuel;
  if (criteria.gearbox?.length === 0) delete criteria.gearbox;

  const hardLimits: HardLimits = {
    maxPriceEur,
    nonNegotiables: lines(formData.get("nonNegotiables")),
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
