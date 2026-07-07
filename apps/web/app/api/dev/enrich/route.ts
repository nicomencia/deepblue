import type { JobPayload } from "@deepblue/core";
import { jobs, leads, listings } from "@deepblue/db";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only: enqueue detail enrichment for shortlisted Wallapop leads that
 * haven't been enriched yet. (New leads enqueue this automatically at
 * ingest time; this backfills leads created before enrichment existed.)
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);

  const rows = await db
    .select({ lead: leads, listing: listings })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .where(
      and(
        eq(leads.state, "shortlisted"),
        eq(listings.platform, "wallapop"),
        isNull(listings.detailFetchedAt),
      ),
    )
    .limit(limit);

  const seen = new Set<string>();
  let created = 0;
  for (const { lead, listing } of rows) {
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);
    const payload: JobPayload = {
      type: "fetch_listing",
      platform: "wallapop",
      platformListingId: listing.platformListingId,
      url: listing.url,
    };
    await db.insert(jobs).values({ userId: lead.userId, type: payload.type, payload });
    created += 1;
  }

  return Response.json({ ok: true, jobsCreated: created });
}
