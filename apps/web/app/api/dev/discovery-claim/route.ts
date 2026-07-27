import { discoveries } from "@deepblue/db";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { claimDiscoveryAnalysis } from "../../../../lib/discovery";

/**
 * Dev-only: exercise or undo the discovery in-flight mark. Body:
 * `{ id, action: "claim" | "release" }`.
 *
 * The guard it tests is a concurrency guard on the most expensive action in
 * the product, and the only other way to see it work is to pay for two real
 * research runs. `claim` twice in a row must answer true then false. `release`
 * hands the mark back, which is also how a genuinely wedged `analyzing` row
 * gets unstuck without waiting out ANALYSIS_STALE_MS.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    id?: string;
    action?: "claim" | "release";
  } | null;
  if (!body?.id) return Response.json({ ok: false, error: "id requerido" }, { status: 400 });

  const db = await getDb();
  const [before] = await db
    .select({ status: discoveries.status, startedAt: discoveries.analysisStartedAt })
    .from(discoveries)
    .where(eq(discoveries.id, body.id))
    .limit(1);
  if (!before) return Response.json({ ok: false, error: "discovery no encontrada" }, { status: 404 });

  if (body.action === "release") {
    await db
      .update(discoveries)
      .set({ status: "pending", analysisStartedAt: null })
      .where(and(eq(discoveries.id, body.id), eq(discoveries.status, "analyzing")));
    return Response.json({ ok: true, action: "release", was: before.status, now: "pending" });
  }

  const won = await claimDiscoveryAnalysis(db, body.id);
  const [after] = await db
    .select({ status: discoveries.status, startedAt: discoveries.analysisStartedAt })
    .from(discoveries)
    .where(eq(discoveries.id, body.id))
    .limit(1);
  return Response.json({
    ok: true,
    action: "claim",
    won,
    was: before.status,
    now: after?.status,
    startedAt: after?.startedAt,
  });
}
