import { modelDossiers } from "@deepblue/db";
import { and, eq } from "drizzle-orm";
import { golf7Dossier } from "../../../../data/golf7-dossier";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only: load the reviewed Golf VII seed dossier. In production, dossiers
 * are drafted by the LLM pipeline and reviewed in the dashboard before
 * reviewedAt is set; this seed was researched and reviewed by hand.
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const [existing] = await db
    .select({ id: modelDossiers.id })
    .from(modelDossiers)
    .where(
      and(eq(modelDossiers.make, golf7Dossier.make), eq(modelDossiers.model, golf7Dossier.model)),
    )
    .limit(1);
  if (existing) {
    // Dev-grade: refresh content in place. The real builder will version instead.
    await db
      .update(modelDossiers)
      .set({ content: golf7Dossier, reviewedAt: new Date() })
      .where(eq(modelDossiers.id, existing.id));
    return Response.json({ ok: true, created: false, refreshed: true });
  }

  await db.insert(modelDossiers).values({
    make: golf7Dossier.make,
    model: golf7Dossier.model,
    generation: golf7Dossier.generation,
    version: 1,
    content: golf7Dossier,
    reviewedAt: new Date(),
  });

  return Response.json({ ok: true, created: true, issues: golf7Dossier.knownIssues.length });
}
