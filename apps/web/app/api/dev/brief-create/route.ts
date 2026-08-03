import { createBrief } from "../../../briefs/actions";

/**
 * Dev-only: create a brief through the SAME server action the form uses, so
 * what this exercises is the real path — validation, hard limits, and the
 * zero-click dossier+sweep chain included.
 *
 * Body is the form's field names: { make, model, maxPriceEur?, yearMin?, ... }.
 * Omitting `maxPriceEur` is the market-watch case (no price ceiling at all).
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body?.make || !body?.model) {
    return Response.json({ ok: false, error: "make y model obligatorios" }, { status: 400 });
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === "") continue;
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, String(v));
  }

  try {
    await createBrief(form);
  } catch (err) {
    return Response.json({ ok: false, error: String(err).slice(0, 300) }, { status: 400 });
  }
  return Response.json({ ok: true });
}
