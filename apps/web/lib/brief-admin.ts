/**
 * Hard-delete a brief and everything that only makes sense inside it: its
 * leads, their per-lead history (events, messages, approvals) and its
 * pending runner jobs. Listings are NEVER touched — the corpus is global
 * knowledge (price benchmarks) that outlives any one search.
 */

import { approvals, briefs, events, jobs, leads, messages, type Db } from "@deepblue/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface BriefDeletion {
  leads: number;
  jobs: number;
}

/**
 * Hard-delete ONE lead and its per-lead history, same FK order as above.
 *
 * This is not an undo for "leads muertos no resucitan" — that rule stands, and
 * nothing in the normal flow calls this. It exists for leads a BUG created or
 * killed (a matcher that read "207RC" as a different car, 2026-07-26): the row
 * is an artefact of broken code, not a judgement the agent made, so removing it
 * lets the ad be adopted cleanly instead of poking a hole in the rule. The
 * listing is never touched — the corpus outlives any lead.
 */
export async function deleteLeadCascade(db: Db, leadId: string): Promise<void> {
  await db.delete(messages).where(eq(messages.leadId, leadId));
  await db.delete(approvals).where(eq(approvals.leadId, leadId));
  await db.delete(events).where(eq(events.leadId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
}

export async function deleteBriefCascade(db: Db, briefId: string): Promise<BriefDeletion> {
  const leadRows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.briefId, briefId));
  const leadIds = leadRows.map((l) => l.id);

  // FK order: children of leads first, then leads, then the brief itself.
  if (leadIds.length > 0) {
    await db.delete(messages).where(inArray(messages.leadId, leadIds));
    await db.delete(approvals).where(inArray(approvals.leadId, leadIds));
    await db.delete(events).where(inArray(events.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }

  // Unfinished runner work for this brief would fail on report ("brief not
  // found"); finished jobs stay as history.
  const deletedJobs = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ["queued", "leased"]),
        sql`${jobs.payload}->>'briefId' = ${briefId}`,
      ),
    )
    .returning({ id: jobs.id });

  await db.delete(briefs).where(eq(briefs.id, briefId));

  return { leads: leadIds.length, jobs: deletedJobs.length };
}
