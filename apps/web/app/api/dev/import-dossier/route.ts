import { modelDossierSchema } from "@deepblue/core";
import { modelDossiers, users } from "@deepblue/db";
import { and, desc, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { insertDossier } from "../../../../lib/dossier-builder";

/**
 * Dev-only read side of the same lane: `?make=&model=` returns the live
 * dossier's content, so a session amending one (a new field, a corrected
 * issue) starts from exactly what is in use and POSTs it back as the next
 * version — dossiers are versioned, never edited in place.
 */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const url = new URL(req.url);
  const make = url.searchParams.get("make")?.toLowerCase();
  const model = url.searchParams.get("model")?.toLowerCase();
  if (!make || !model) return Response.json({ ok: false, error: "make y model obligatorios" }, { status: 400 });

  const db = await getDb();
  const rows = await db
    .select({ id: modelDossiers.id, version: modelDossiers.version, content: modelDossiers.content })
    .from(modelDossiers)
    .where(
      and(
        sql`lower(${modelDossiers.make}) = ${make} and lower(${modelDossiers.model}) = ${model}`,
        isNull(modelDossiers.disabledAt),
      ),
    )
    .orderBy(desc(modelDossiers.version));
  return Response.json({ ok: true, dossiers: rows });
}

/**
 * Dev-only: import a ready-made dossier — the no-API-key lane, where a
 * Claude Code session does the web research on the user's subscription and
 * POSTs the result here. Same zod trust boundary as the automated builder;
 * the dossier goes live on arrival (auto-approval) and /dossiers can
 * disable it on review.
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

  const built = await insertDossier(db, parsed.data, user.id, "manual_import");
  return Response.json({
    ok: true,
    id: built.id,
    version: built.version,
    issues: built.dossier.knownIssues.length,
    reviewUrl: "/dossiers",
  });
}
