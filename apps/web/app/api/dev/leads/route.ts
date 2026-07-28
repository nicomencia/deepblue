import type { LeadState } from "@deepblue/core";
import { leads, listings } from "@deepblue/db";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only: shortlisted leads with full verdicts, best grades first.
 * ?id=<leadId> returns that single lead whatever its state — the way to
 * inspect a contacted/negotiating lead's verdict mid-conversation.
 * ?state=<leadState> lists another state instead — `dead` with its reason is
 * how you answer "why did that one drop out?" without opening a DB shell
 * (PGlite is single-writer, so there is no second connection to open).
 * ?briefId=<id> narrows to one brief; without it the list is global, which
 * once had me reading another brief's leads as if they were this one's.
 */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 200);
  const platform = url.searchParams.get("platform");
  const id = url.searchParams.get("id");
  const state = (url.searchParams.get("state") ?? "shortlisted") as LeadState;

  const briefId = url.searchParams.get("briefId");

  const rows = await db
    .select({ lead: leads, listing: listings })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(id ? eq(leads.id, id) : eq(leads.state, state))
    .orderBy(asc(sql`${leads.verdict}->>'overall'`), asc(listings.priceEur))
    .limit(200);

  const result = rows
    .filter((r) => !platform || r.listing.platform === platform)
    .filter((r) => !briefId || r.lead.briefId === briefId)
    .slice(0, limit)
    .map(({ lead, listing }) => ({
      id: lead.id,
      briefId: lead.briefId,
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
      imageUrl: listing.imageUrl,
      state: lead.state,
      deadReason: lead.deadReason,
      createdAt: lead.createdAt,
      enrichedAt: lead.enrichedAt,
      verdict: lead.verdict,
    }));

  return Response.json(result);
}
