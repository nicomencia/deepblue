import { discoveryProfileSchema } from "@deepblue/core";
import { discoveries, users } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: create a discovery session from a raw profile. Body: { profile } */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as { profile?: unknown } | null;
  const parsed = discoveryProfileSchema.safeParse(body?.profile);
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }
  const db = await getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    return Response.json({ ok: false, error: "no user yet — POST /api/dev/seed first" }, { status: 409 });
  }
  const [row] = await db
    .insert(discoveries)
    .values({ userId: user.id, profile: parsed.data })
    .returning({ id: discoveries.id });
  return Response.json({ ok: true, id: row?.id });
}

/** Dev-only: archive a session. Body: { id } */
export async function PATCH(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return Response.json({ ok: false, error: "id obligatorio" }, { status: 400 });
  const db = await getDb();
  await db.update(discoveries).set({ status: "archived" }).where(eq(discoveries.id, body.id));
  return Response.json({ ok: true });
}

/** Dev-only: discovery sessions with their intake profiles (subscription lane reads these). */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();
  const rows = await db.select().from(discoveries).orderBy(desc(discoveries.createdAt));
  return Response.json(
    rows.map((d) => ({
      id: d.id,
      status: d.status,
      profile: d.profile,
      report: d.report,
      reportSource: d.reportSource,
      createdAt: d.createdAt,
    })),
  );
}
