import { getDb } from "../../../../lib/db";
import { enqueueListingChecks } from "../../../../lib/reaper";

/**
 * Dev-only: enqueue listing liveness probes now (bypasses the recheck delay
 * via ?recheckHours=0 to probe everything). Run the runner to process them.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const recheckHours = Number(url.searchParams.get("recheckHours") ?? 36);

  const db = await getDb();
  const stats = await enqueueListingChecks(db, limit, recheckHours);
  return Response.json({ ok: true, ...stats });
}
