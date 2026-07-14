import { listings } from "@deepblue/db";
import { desc, eq, or } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: a listing's stored raw platform payload, for adapter archaeology. */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const latest = url.searchParams.get("latest"); // platform name: newest stored listing
  if (!id && !latest) {
    return Response.json(
      { ok: false, error: "?id=<uuid|platformListingId> or ?latest=<platform>" },
      { status: 400 },
    );
  }

  const [row] = id
    ? await db
        .select()
        .from(listings)
        .where(or(eq(listings.platformListingId, id), eq(listings.id, id)))
        .limit(1)
    : await db
        .select()
        .from(listings)
        .where(eq(listings.platform, latest as "wallapop" | "autoscout24"))
        .orderBy(desc(listings.lastSeenAt))
        .limit(1);
  if (!row) return Response.json({ ok: false, error: "listing not found" }, { status: 404 });

  return Response.json({
    ok: true,
    id: row.id,
    platform: row.platform,
    platformListingId: row.platformListingId,
    title: row.title,
    raw: row.raw,
  });
}
