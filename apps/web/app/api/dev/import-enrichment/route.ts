import { llmEnrichmentPayloadSchema } from "@deepblue/core";
import { briefs, leads, listings } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../lib/db";
import { saveEnrichment } from "../../../../lib/enrich-verdict";

const bodySchema = z.object({
  leadId: z.string(),
  /** Provenance shown on the verdict, e.g. "claude-fable-5 (claude code)". */
  source: z.string().optional(),
  enrichment: llmEnrichmentPayloadSchema,
});

/**
 * Dev-only: import a verdict enrichment for one lead — the no-API-key lane,
 * where a Claude Code session reads the ad and POSTs its refinement here.
 * Same clamps and veto caps as the automated pass (applyEnrichment); safe
 * to re-import (the verdict is rebuilt from rules before merging).
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const db = await getDb();
  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, parsed.data.leadId))
    .limit(1);
  if (!row) return Response.json({ ok: false, error: "lead not found" }, { status: 404 });
  if (!row.lead.verdict) {
    return Response.json({ ok: false, error: "lead has no verdict yet" }, { status: 409 });
  }

  const result = await saveEnrichment(
    db,
    row.lead,
    row.listing,
    row.brief,
    parsed.data.enrichment,
    parsed.data.source ?? "claude-code-session",
  );
  return Response.json({ ok: true, ...result });
}
