import { briefs, events } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../lib/db";

const bodySchema = z.object({
  briefId: z.string().uuid(),
  status: z.enum(["active", "paused", "fulfilled", "archived"]),
});

/** Dev-only: flip a brief's status — same transition the /briefs UI offers. */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const db = await getDb();
  const [updated] = await db
    .update(briefs)
    .set({ status: parsed.data.status })
    .where(eq(briefs.id, parsed.data.briefId))
    .returning({ id: briefs.id, name: briefs.name, status: briefs.status });
  if (!updated) return Response.json({ ok: false, error: "brief not found" }, { status: 404 });

  await db.insert(events).values({
    userId: (await db.select().from(briefs).where(eq(briefs.id, updated.id)).limit(1))[0]!.userId,
    type: "brief_status_changed",
    payload: { briefId: updated.id, status: updated.status, source: "dev_endpoint" },
  });
  return Response.json({ ok: true, ...updated });
}
