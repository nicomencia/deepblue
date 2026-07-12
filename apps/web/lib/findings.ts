/**
 * Manual seller-verification loop: record what the seller proved (or admitted)
 * about one known issue, then re-evaluate so the score and confidence move.
 * Phase 2 chat will feed this same path automatically.
 */

import type { IssueFinding } from "@deepblue/core";
import { briefs, events, leads, listings, type Db } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

export type FindingStatus = IssueFinding["status"] | "unconfirmed";

export async function applyIssueFinding(
  db: Db,
  leadId: string,
  title: string,
  status: FindingStatus,
  note?: string,
): Promise<{ overall: string }> {
  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) throw new Error(`lead ${leadId} not found`);

  // Replace this issue's finding; "unconfirmed" reopens it (removes the entry).
  const others = (row.lead.issueFindings ?? []).filter((f) => f.title !== title);
  const findings: IssueFinding[] =
    status === "unconfirmed"
      ? others
      : [...others, { title, status, note: note?.trim() || undefined, at: new Date().toISOString() }];

  await db.update(leads).set({ issueFindings: findings }).where(eq(leads.id, leadId));

  const result = await reevaluateLead(
    db,
    { ...row.lead, issueFindings: findings },
    row.listing,
    row.brief,
    newEvalCaches(),
  );

  await db.insert(events).values({
    userId: row.lead.userId,
    leadId,
    type: "issue_finding",
    payload: { title, status, note: note?.trim() || undefined, overall: result.overall },
  });

  return { overall: result.overall };
}
