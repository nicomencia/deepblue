import { users } from "@deepblue/db";
import { getDb } from "../../../../lib/db";
import { adoptListing } from "../../../../lib/adopt";

/** Dev-only: adopt an ad by URL (same path as the dashboard form).
 * Body: { url, maxPriceEur?, briefId? } */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    url?: string;
    maxPriceEur?: number;
    briefId?: string;
  } | null;
  if (!body?.url) {
    return Response.json({ ok: false, error: "url es obligatoria" }, { status: 400 });
  }

  const db = await getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    return Response.json({ ok: false, error: "no user yet — POST /api/dev/seed first" }, { status: 409 });
  }
  const result = await adoptListing(db, user.id, body);
  return result.ok
    ? Response.json(result)
    : Response.json(result, { status: 400 });
}
