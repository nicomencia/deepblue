import { briefs } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../lib/db";

/** Dev-only: briefs with their criteria, to see what the agent is hunting. */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();
  const rows = await db.select().from(briefs);
  return Response.json(
    rows.map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      criteria: b.criteria,
      hardLimits: b.hardLimits,
      createdAt: b.createdAt,
    })),
  );
}

const patchSchema = z.object({
  id: z.string(),
  // `null` clears the area — the brief then covers all of Spain. Distinct from
  // omitting the key, which leaves the existing area untouched.
  location: z.object({ lat: z.number(), lon: z.number(), radiusKm: z.number() }).nullable().optional(),
  name: z.string().min(1).optional(),
});

/** Dev-only: retarget a brief's search area without retyping the whole form. */
export async function PATCH(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });

  const db = await getDb();
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, parsed.data.id)).limit(1);
  if (!brief) return Response.json({ error: "brief not found" }, { status: 404 });

  const patch: { criteria?: typeof brief.criteria; name?: string } = {};
  if (parsed.data.location !== undefined) {
    const criteria = { ...brief.criteria };
    if (parsed.data.location) criteria.location = parsed.data.location;
    else delete criteria.location;
    patch.criteria = criteria;
  }
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (Object.keys(patch).length === 0) {
    return Response.json({ ok: false, error: "nada que cambiar" }, { status: 400 });
  }

  await db.update(briefs).set(patch).where(eq(briefs.id, brief.id));
  return Response.json({ ok: true, id: brief.id, ...patch });
}
