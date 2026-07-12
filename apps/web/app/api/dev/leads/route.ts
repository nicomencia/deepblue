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
      make: listing.make,
      model: listing.model,
      description: listing.description?.slice(0, 2500) ?? null,
      priceEur: listing.priceEur,
      cashPriceEur: listing.cashPriceEur,
      year: listing.year,
      km: listing.km,
      fuel: listing.fuel,
      gearbox: listing.gearbox,
      powerCv: listing.powerCv,
      version: listing.version,
      sellerType: listing.sellerType,
      sellerName: listing.sellerName,
      sellerRating: listing.sellerRating,
      sellerReviewCount: listing.sellerReviewCount,
      sellerSoldCount: listing.sellerSoldCount,
      location: listing.locationText,
      url: listing.url,
      state: lead.state,
      enrichedAt: lead.enrichedAt,
      verdict: lead.verdict,
    }));

  return Response.json(result);
}
