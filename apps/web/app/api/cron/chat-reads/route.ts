import { readPendingConversations } from "../../../../lib/chat-reads";
import { isAuthorizedCron } from "../../../../lib/cron-auth";
import { getDb } from "../../../../lib/db";

/**
 * Interpret conversations with fresh seller replies (LLM lane). No-op
 * without ANTHROPIC_API_KEY — the subscription lane imports readings via
 * /api/dev/import-chat-read instead.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  const db = await getDb();
  const stats = await readPendingConversations(db);
  return Response.json({ ok: true, ...stats });
}
