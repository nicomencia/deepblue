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
  location: z.object({ lat: z.number(), lon: z.number(), radiusKm: z.number() }),
});

/** Dev-only: fix a brief's search center — there is no brief-edit UI yet. */
export async function PATCH(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });

  const db = await getDb();
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, parsed.data.id)).limit(1);
  if (!brief) return Response.json({ error: "brief not found" }, { status: 404 });

  const criteria = { ...brief.criteria, location: parsed.data.location };
  await db.update(briefs).set({ criteria }).where(eq(briefs.id, brief.id));
  return Response.json({ ok: true, id: brief.id, location: parsed.data.location });
}
