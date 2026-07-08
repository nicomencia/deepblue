import { modelDossierSchema } from "@deepblue/core";
import { users } from "@deepblue/db";
import { getDb } from "../../../../lib/db";
import { insertDraftDossier } from "../../../../lib/dossier-builder";

/**
 * Dev-only: import a ready-made dossier as an unreviewed draft — the
 * no-API-key lane, where a Claude Code session does the web research on the
 * user's subscription and POSTs the result here. Same zod trust boundary,
 * same human-approval gate in /dossiers as the automated builder.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const parsed = modelDossierSchema.safeParse(await req.json().catch(() => null));
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

  const built = await insertDraftDossier(db, parsed.data, user.id, "manual_import");
  return Response.json({
    ok: true,
    id: built.id,
    version: built.version,
    issues: built.dossier.knownIssues.length,
    reviewUrl: "/dossiers",
  });
}
