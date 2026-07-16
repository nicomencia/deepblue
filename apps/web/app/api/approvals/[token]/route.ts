/**
 * One-click approval links from email. The unguessable token IS the
 * credential (email links can't carry headers); a decided approval never
 * re-fires, so a re-clicked or forwarded link is inert.
 */

import { getDb } from "../../../../lib/db";
import { decideApproval } from "../../../../lib/outreach";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const decision = new URL(req.url).searchParams.get("decision");
  if (decision !== "approve" && decision !== "reject") {
    return html("Falta ?decision=approve|reject en el enlace.", 400);
  }

  const db = await getDb();
  const result = await decideApproval(db, token, decision);

  const leadLink = result.leadId
    ? `<p><a href="/leads/${result.leadId}">Ver el lead →</a></p>`
    : "";
  if (!result.ok) return html(`<p>${result.error}</p>${leadLink}`, 409);
  return html(
    decision === "approve"
      ? `<p>✅ Mensaje aprobado — el runner lo enviará en breve.</p>${leadLink}`
      : `<p>🚫 Mensaje rechazado — queda como borrador inerte.</p>${leadLink}`,
  );
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>deepblue</title>` +
      `<body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 1rem">` +
      `<h1 style="font-size:1.1rem">deepblue</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
