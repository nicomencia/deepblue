import { briefs, leads, listings } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { newEvalCaches, reevaluateLead } from "../../../../lib/reevaluate";

/**
 * Dev-only: re-run evaluation for all shortlisted leads with the current
 * dossier and price benchmark (both improve over time).
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.state, "shortlisted"));

  const caches = newEvalCaches();
  let died = 0;
  for (const row of rows) {
    const r = await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
    if (r.outcome === "dead") died += 1;
  }

  return Response.json({ ok: true, reevaluated: rows.length, died });
}
