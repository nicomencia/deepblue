/**
 * Retry guard for the per-lead LLM lanes (ad enrichment, chat readings).
 *
 * Both lanes pick "leads without a success mark" on every scheduler tick. A
 * success mark alone is not a cost guard: a lead whose call keeps failing
 * (refusal, truncation, a payload the schema rejects) never earns the mark,
 * so it was paid for again every 15 minutes, forever — and, sorted to the top
 * of a bounded batch, it kept healthy leads from ever being reached.
 *
 * Same shape as the dossier lane (brief-hunt.ts): failures are events, and a
 * lead that failed within the hour or ≥3 times in 24 h is skipped. Recomputed
 * from the audit log, so it survives restarts and needs no extra column.
 */

import { events, type Db } from "@deepblue/db";
import { and, eq, gte, isNotNull } from "drizzle-orm";

export const LLM_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
export const LLM_RETRY_DAILY_CEILING = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LlmFailureEvent = "lead_enrich_failed" | "chat_read_failed";

/** Pure rule: given a lead's failure times, is it too soon to pay again? */
export function isRetryThrottled(failureTimes: Date[], now: Date): boolean {
  const recent = failureTimes.filter((t) => now.getTime() - t.getTime() < DAY_MS);
  if (recent.length >= LLM_RETRY_DAILY_CEILING) return true;
  return recent.some((t) => now.getTime() - t.getTime() < LLM_RETRY_COOLDOWN_MS);
}

/** Leads this lane must skip right now. */
export async function throttledLeadIds(db: Db, type: LlmFailureEvent): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .select({ leadId: events.leadId, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.type, type),
        isNotNull(events.leadId),
        gte(events.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );

  const byLead = new Map<string, Date[]>();
  for (const row of rows) {
    if (!row.leadId) continue;
    const times = byLead.get(row.leadId) ?? [];
    times.push(row.createdAt);
    byLead.set(row.leadId, times);
  }
  return [...byLead].filter(([, times]) => isRetryThrottled(times, now)).map(([id]) => id);
}

/** Record a failed call. Never throws: losing the mark must not mask the error. */
export async function recordLlmFailure(
  db: Db,
  args: { userId: string; leadId: string; type: LlmFailureEvent; error: unknown },
): Promise<void> {
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  try {
    await db.insert(events).values({
      userId: args.userId,
      leadId: args.leadId,
      type: args.type,
      payload: { error: message.slice(0, 300) },
    });
  } catch (err) {
    console.error(`could not record ${args.type}:`, err instanceof Error ? err.message : err);
  }
}
