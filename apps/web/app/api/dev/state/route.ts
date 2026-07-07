import { briefs, jobs, leads, listings, users } from "@deepblue/db";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/** Dev-only: quick counts for debugging and end-to-end verification. */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const n = sql<number>`count(*)::int`;
  const [userCount] = await db.select({ n }).from(users);
  const [briefCount] = await db.select({ n }).from(briefs);
  const [listingCount] = await db.select({ n }).from(listings);
  const jobsByStatus = await db
    .select({ status: jobs.status, n })
    .from(jobs)
    .groupBy(jobs.status);
  const leadsByState = await db
    .select({ state: leads.state, n })
    .from(leads)
    .groupBy(leads.state);

  return Response.json({
    users: userCount?.n ?? 0,
    briefs: briefCount?.n ?? 0,
    listings: listingCount?.n ?? 0,
    jobs: Object.fromEntries(jobsByStatus.map((r) => [r.status, r.n])),
    leads: Object.fromEntries(leadsByState.map((r) => [r.state, r.n])),
  });
}
