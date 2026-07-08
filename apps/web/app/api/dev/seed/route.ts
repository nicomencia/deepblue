import type { BriefCriteria, HardLimits } from "@deepblue/core";
import { briefs, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: idempotently create the dev user and a sample brief. */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const email = process.env.DEV_USER_EMAIL ?? "nicomencia4@gmail.com";
  const [user] =
    (await db.select().from(users).where(eq(users.email, email)).limit(1)).length > 0
      ? await db.select().from(users).where(eq(users.email, email)).limit(1)
      : await db.insert(users).values({ email }).returning();
  if (!user) return new Response("could not create user", { status: 500 });

  const briefName = "Golf VII para diario";
  const [existing] = await db
    .select()
    .from(briefs)
    .where(eq(briefs.name, briefName))
    .limit(1);
  if (existing) {
    // Idempotent upgrade: newer criteria fields land on the existing brief.
    if (!existing.criteria.sellerPreference) {
      await db
        .update(briefs)
        .set({ criteria: { ...existing.criteria, sellerPreference: "prefer_private" } })
        .where(eq(briefs.id, existing.id));
    }
    return Response.json({ ok: true, userId: user.id, briefId: existing.id, created: false });
  }

  const criteria: BriefCriteria = {
    vehicles: [{ make: "Volkswagen", model: "Golf" }],
    yearMin: 2015,
    kmMax: 140_000,
    targetPriceEur: 13_500,
    location: { lat: 40.4168, lon: -3.7038, radiusKm: 100 },
    riskTolerance: "medium",
    sellerPreference: "prefer_private",
    notes: ["Sin accidentes graves", "Preferible pocos propietarios"],
  };
  const hardLimits: HardLimits = {
    maxPriceEur: 15_500,
    nonNegotiables: ["ITV en vigor", "Sin reparaciones estructurales"],
  };

  const [brief] = await db
    .insert(briefs)
    .values({ userId: user.id, name: briefName, criteria, hardLimits })
    .returning();

  return Response.json({ ok: true, userId: user.id, briefId: brief?.id, created: true });
}
