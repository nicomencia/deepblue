import { deleteDossier } from "../../../dossiers/actions";

/**
 * Dev-only: delete a dossier by id, through the SAME server action the UI
 * button uses — so the leads of that model get re-evaluated and the
 * `dossier_deleted` event is written exactly as it would be from the page.
 * A raw DELETE here would leave verdicts scored against a dossier that no
 * longer exists.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return Response.json({ ok: false, error: "id obligatorio" }, { status: 400 });

  const form = new FormData();
  form.set("id", body.id);
  try {
    await deleteDossier(form);
  } catch (err) {
    return Response.json({ ok: false, error: String(err).slice(0, 200) }, { status: 404 });
  }
  return Response.json({ ok: true, deleted: body.id });
}
