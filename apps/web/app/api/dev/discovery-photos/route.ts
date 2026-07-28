import { discoveries } from "@deepblue/db";
import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import type { BodyStyle } from "@deepblue/core";
import { backfillDiscoveryPhotos } from "../../../../lib/discovery";

/**
 * Dev-only: give already-stored reports the photos they were saved without.
 *
 * New reports get them in `saveDiscoveryReport`, but the ones written before
 * that would otherwise stay faceless until the user paid for another analysis.
 * Free (Wikipedia/Commons, no LLM) and idempotent — a recommendation that
 * already has a photo is skipped. Optional `{ id }` to do just one.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as { id?: string; force?: boolean; assumeBody?: BodyStyle } | null;
  const db = await getDb();

  const rows = await db
    .select()
    .from(discoveries)
    .where(body?.id ? eq(discoveries.id, body.id) : ne(discoveries.status, "archived"));

  const results: Array<{ id: string; filled: number; of: number }> = [];
  for (const row of rows) {
    if (!row.report) continue;
    const filled = await backfillDiscoveryPhotos(db, row.id, body?.force === true, body?.assumeBody);
    results.push({ id: row.id, filled, of: row.report.recommendations.length });
  }

  return Response.json({ ok: true, discoveries: results });
}
