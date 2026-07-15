import { briefs, events } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { deleteBriefCascade } from "../../../../lib/brief-admin";
import { getDb } from "../../../../lib/db";

/** Dev-only: hard-delete a brief — same cascade the /briefs Eliminar uses. */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const parsed = z
    .object({ briefId: z.string().uuid() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const db = await getDb();
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, parsed.data.briefId)).limit(1);
  if (!brief) return Response.json({ ok: false, error: "brief not found" }, { status: 404 });

  const deleted = await deleteBriefCascade(db, brief.id);
  await db.insert(events).values({
    userId: brief.userId,
    type: "brief_deleted",
    payload: { briefId: brief.id, name: brief.name, ...deleted, source: "dev_endpoint" },
  });
  return Response.json({ ok: true, name: brief.name, ...deleted });
}
