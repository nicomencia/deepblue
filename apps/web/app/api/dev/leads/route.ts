import { leads, listings } from "@deepblue/db";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: shortlisted leads with full verdicts, best grades first. */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 200);
  const platform = url.searchParams.get("platform");

  const rows = await db
    .select({ lead: leads, listing: listings })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(eq(leads.state, "shortlisted"))
    .orderBy(asc(sql`${leads.verdict}->>'overall'`), asc(listings.priceEur))
    .limit(200);

  const result = rows
    .filter((r) => !platform || r.listing.platform === platform)
    .slice(0, limit)
    .map(({ lead, listing }) => ({
      id: lead.id,
      platform: listing.platform,
      title: listing.title,
      priceEur: listing.priceEur,
      year: listing.year,
      km: listing.km,
      fuel: listing.fuel,
      gearbox: listing.gearbox,
      sellerType: listing.sellerType,
      location: listing.locationText,
      url: listing.url,
      state: lead.state,
      verdict: lead.verdict,
    }));

  return Response.json(result);
}
