import { gradeAtMost, type ConfidenceGrade } from "@deepblue/core";
import { briefs, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { composeDigest, digestWindowStart, newCandidates } from "../../../../lib/digest";

/**
 * Dev-only: render the digest that WOULD be sent, without sending it and
 * without writing a `digest_run` event.
 *
 * Both side effects matter: the real digest goes to the user's inbox, and the
 * event is what moves the window — forcing a send to "just look at it" would
 * silently suppress that day's genuine digest. `?html=1` returns the HTML body
 * so it can be opened in a browser; the default is the plain-text body.
 */
export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();

  const [owner] = await db
    .selectDistinct({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(briefs, eq(briefs.userId, users.id))
    .where(eq(briefs.status, "active"));
  if (!owner) return Response.json({ ok: false, error: "no hay usuario con búsquedas activas" });

  // `?hours=N` widens the window for inspection only — handy when the last
  // digest just ran and the real window holds one search's worth of leads.
  const hours = Number(new URL(req.url).searchParams.get("hours"));
  const windowStart =
    Number.isFinite(hours) && hours > 0
      ? new Date(Date.now() - hours * 3600 * 1000)
      : await digestWindowStart(db, owner.id);
  const fresh = await newCandidates(db, owner.id, windowStart);
  // Same floor as the real digest, so the preview is not rosier than the mail.
  const floor = (process.env.DIGEST_MAX_GRADE ?? "C") as ConfidenceGrade;
  const mailable = fresh.filter((r) => r.lead.verdict != null && gradeAtMost(r.lead.verdict.overall, floor));

  if (mailable.length === 0) {
    return Response.json({
      ok: true,
      windowStart: windowStart.toISOString(),
      candidates: 0,
      note: "nada que enviar en esta ventana",
    });
  }

  const { text, html } = composeDigest(mailable);
  const wantsHtml = new URL(req.url).searchParams.get("html") === "1";
  return new Response(wantsHtml ? html : text, {
    headers: {
      "content-type": `${wantsHtml ? "text/html" : "text/plain"}; charset=utf-8`,
      "x-digest-window-start": windowStart.toISOString(),
      "x-digest-candidates": String(mailable.length),
    },
  });
}
