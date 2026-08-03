"use server";

import type { BriefCriteria, HardLimits } from "@deepblue/core";
import { briefs, events, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { deleteBriefCascade } from "../../lib/brief-admin";
import { startBriefHunt } from "../../lib/brief-hunt";
import { getDb } from "../../lib/db";
import { reevaluateBriefLeads } from "../../lib/reevaluate";
import { searchArea } from "../../lib/search-area";

const num = (v: FormDataEntryValue | null): number | undefined => {
  const n = Number(String(v ?? "").replace(/[.\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Coordinates keep their decimal point (num strips es-ES thousands dots) and
 * accept the Spanish comma; empty → undefined so callers can default — a bare
 * Number("") is 0, which once aimed a sweep at the Gulf of Guinea. */
const coord = (v: FormDataEntryValue | null): number | undefined => {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
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

/** Shared create/edit parsing: one field set, one semantics. */
function parseBriefForm(formData: FormData): {
  name: string;
  make: string;
  model: string;
  generation?: string;
  criteria: BriefCriteria;
  hardLimits: HardLimits;
} {
  const make = String(formData.get("make") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();
  // Price is OPTIONAL: a market-watch brief ("what does a Renault Sport Spider
  // go for?") exists to answer that question, so demanding the answer up front
  // made the search impossible to create.
  const maxPriceEur = num(formData.get("maxPriceEur"));
  if (!make || !model) {
    throw new Error("marca y modelo son obligatorios");
  }

  // Generation is advisory (dossier-first machinery + card display); the year
  // bounds do the actual filtering — sweep query and evaluation both enforce.
  const generation = String(formData.get("generation") ?? "").trim() || undefined;
  const area = searchArea(formData);
  const criteria: BriefCriteria = {
    vehicles: [{ make, model, ...(generation ? { generations: [generation] } : {}) }],
    yearMin: num(formData.get("yearMin")),
    yearMax: num(formData.get("yearMax")),
    kmMax: num(formData.get("kmMax")),
    targetPriceEur: num(formData.get("targetPriceEur")),
    fuel: fuelSchema.catch([]).parse(formData.getAll("fuel").map(String)) || undefined,
    gearbox: gearboxSchema.catch([]).parse(formData.getAll("gearbox").map(String)) || undefined,
    // Empty radius → no location at all → all of Spain (see searchArea). It
    // used to default to Madrid/100 km, which silently shrank every brief the
    // user left blank down to one city.
    ...(area ? { location: area } : {}),
    riskTolerance: riskSchema.parse(String(formData.get("riskTolerance") ?? "medium")),
    sellerPreference: sellerPrefSchema.parse(String(formData.get("sellerPreference") ?? "any")),
    notes: lines(formData.get("notes")),
  };
  if (criteria.fuel?.length === 0) delete criteria.fuel;
  if (criteria.gearbox?.length === 0) delete criteria.gearbox;

  const hardLimits: HardLimits = {
    ...(maxPriceEur !== undefined ? { maxPriceEur } : {}),
    nonNegotiables: lines(formData.get("nonNegotiables")),
    ...(formData.get("noRhd") ? { noRhd: true } : {}),
    ...(formData.get("requireSpanishPlates") ? { requireSpanishPlates: true } : {}),
  };

  const name =
    String(formData.get("name") ?? "").trim() ||
    (maxPriceEur !== undefined ? `${make} ${model} hasta ${maxPriceEur} €` : `${make} ${model}`);

  return { name, make, model, generation, criteria, hardLimits };
}

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

  const parsed = parseBriefForm(formData);
  await db.insert(briefs).values({
    userId: user.id,
    name: parsed.name,
    criteria: parsed.criteria,
    hardLimits: parsed.hardLimits,
  });

  // Zero-click chain: uncovered generation → dossier research fires now and
  // its completion sweeps + enriches; covered → sweep immediately.
  await startBriefHunt(db, user.id, {
    make: parsed.make,
    model: parsed.model,
    generation: parsed.generation,
    yearMin: parsed.criteria.yearMin,
    yearMax: parsed.criteria.yearMax,
  });

  revalidatePath("/briefs");
}

/**
 * Edit an existing brief with the same form. Vehicles beyond the first have
 * no form fields — they carry over untouched. Saving re-evaluates the brief's
 * leads (tighter limits kill now — dead never resurrects, wider limits
 * surface on the next sweep) and re-runs the zero-click chain for the
 * possibly-changed model/generation.
 */
export async function updateBrief(formData: FormData): Promise<void> {
  const db = await getDb();
  const id = String(formData.get("id") ?? "");
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
  if (!brief) throw new Error(`brief ${id} not found`);

  const parsed = parseBriefForm(formData);
  const criteria: BriefCriteria = {
    ...parsed.criteria,
    vehicles: [...parsed.criteria.vehicles, ...brief.criteria.vehicles.slice(1)],
  };
  await db
    .update(briefs)
    .set({ name: parsed.name, criteria, hardLimits: parsed.hardLimits })
    .where(eq(briefs.id, id));

  const reevaluated = await reevaluateBriefLeads(db, id);
  await db.insert(events).values({
    userId: brief.userId,
    type: "brief_edited",
    payload: { briefId: id, name: parsed.name, reevaluated },
  });

  await startBriefHunt(db, brief.userId, {
    make: parsed.make,
    model: parsed.model,
    generation: parsed.generation,
    yearMin: criteria.yearMin,
    yearMax: criteria.yearMax,
  });

  revalidatePath("/briefs");
  revalidatePath("/");
  redirect("/briefs");
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
