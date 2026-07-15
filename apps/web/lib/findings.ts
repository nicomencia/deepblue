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

export type ImportFactField = "rhd" | "foreignPlates";
export type ImportFactValue = "true" | "false" | "unknown";

/**
 * Mark a verified import fact on the lead's LISTING (the fact belongs to the
 * car, so every brief watching it benefits), then re-evaluate. "unknown"
 * clears the mark and text inference takes over again.
 */
export async function applyImportFact(
  db: Db,
  leadId: string,
  field: ImportFactField,
  value: ImportFactValue,
): Promise<{ overall: string }> {
  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) throw new Error(`lead ${leadId} not found`);

  const stored = value === "unknown" ? null : value === "true";
  await db.update(listings).set({ [field]: stored }).where(eq(listings.id, row.listing.id));

  const result = await reevaluateLead(
    db,
    row.lead,
    { ...row.listing, [field]: stored },
    row.brief,
    newEvalCaches(),
  );

  await db.insert(events).values({
    userId: row.lead.userId,
    leadId,
    type: "import_fact",
    payload: { field, value, overall: result.overall },
  });

  return { overall: result.overall };
}
