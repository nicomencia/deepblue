import { users } from "@deepblue/db";
import { z } from "zod";
import { getDb } from "../../../../lib/db";
import { buildDossier } from "../../../../lib/dossier-builder";

const bodySchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  generation: z.string().optional(),
  engines: z.array(z.string()).optional(),
});

/**
 * Dev-only: draft a model dossier with Claude + web research.
 * curl -X POST localhost:3000/api/dev/build-dossier \
 *   -H 'content-type: application/json' -d '{"make":"Volkswagen","model":"Golf"}'
 * The draft lands unreviewed — approve it in /dossiers before it drives claims.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const db = await getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    return Response.json(
      { ok: false, error: "no user yet — POST /api/dev/seed first" },
      { status: 409 },
    );
  }

  try {
    const built = await buildDossier(db, parsed.data, user.id);
    return Response.json({
      ok: true,
      id: built.id,
      version: built.version,
      issues: built.dossier.knownIssues.length,
      recalls: built.dossier.recalls.length,
      sources: built.dossier.sources.length,
      reviewUrl: "/dossiers",
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
