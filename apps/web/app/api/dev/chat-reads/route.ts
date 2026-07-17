import { conversationReadingPayloadSchema } from "@deepblue/core";
import {
  conversationForLead,
  conversationPrompt,
  pendingConversations,
  saveConversationReading,
} from "../../../../lib/chat-reads";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only, subscription lane: a Claude Code session interprets seller
 * conversations instead of the API cron.
 * GET  → pending conversations, each with its interpretation prompt
 * POST { leadId, reading } → validate and apply one reading
 */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const db = await getDb();
  const pending = await pendingConversations(db);
  return Response.json({
    ok: true,
    pending: pending.map((p) => ({
      leadId: p.lead.id,
      title: p.listing.title,
      state: p.lead.state,
      overall: p.lead.verdict?.overall,
      prompt: conversationPrompt(p),
    })),
  });
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as { leadId?: string; reading?: unknown } | null;
  if (!body?.leadId || !body.reading) {
    return Response.json({ ok: false, error: "leadId y reading son obligatorios" }, { status: 400 });
  }

  // Re-reads are allowed: a new reading REPLACES the stored one (it always
  // covers the whole conversation), so correcting an interpretation is safe.
  const db = await getDb();
  const p = await conversationForLead(db, body.leadId);
  if (!p) {
    return Response.json(
      { ok: false, error: "ese lead no tiene conversación con mensajes del vendedor" },
      { status: 409 },
    );
  }

  // Trust boundary: whatever lane produced it, nothing unvalidated lands.
  const payload = conversationReadingPayloadSchema.parse(body.reading);
  const result = await saveConversationReading(db, p, payload, "claude-code-session");
  return Response.json({ ok: true, ...result });
}
