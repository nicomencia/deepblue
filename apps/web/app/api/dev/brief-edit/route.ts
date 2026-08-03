import { updateBrief } from "../../../briefs/actions";

/**
 * Dev-only: edit a brief through the SAME server action the form uses.
 * Body is the form's field names plus `id` — `modelAliases` may be an array or
 * newline-separated text, exactly like the textarea.
 *
 * The action ends in redirect("/briefs"), which Next implements by THROWING;
 * that throw means success here, so it is matched and swallowed rather than
 * reported as a failure.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body?.id) return Response.json({ ok: false, error: "id obligatorio" }, { status: 400 });

  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "modelAliases" && Array.isArray(value)) {
      form.set(key, value.join("\n"));
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, String(v));
  }

  try {
    await updateBrief(form);
  } catch (err) {
    const digest = (err as { digest?: string })?.digest ?? "";
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return Response.json({ ok: true, redirected: true });
    }
    return Response.json({ ok: false, error: String(err).slice(0, 300) }, { status: 400 });
  }
  return Response.json({ ok: true });
}
