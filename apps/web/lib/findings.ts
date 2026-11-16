/**
 * Manual seller-verification loop: record what the seller proved (or admitted)
 * about one known issue, then re-evaluate so the score and confidence move.
 * Phase 2 chat will feed this same path automatically.
 */

import type { Drivetrain, IssueFinding } from "@deepblue/core";
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
  const stored = value === "unknown" ? null : value === "true";
  return applyVerifiedFact(db, leadId, { [field]: stored }, "import_fact", { field, value });
}

export type DrivetrainFactValue = Drivetrain | "unknown";

/**
 * Mark the drivetrain the user read off the photos — the "4x4" badge on the
 * tailgate of an ad whose text never mentions it. Same contract as the import
 * facts above, on purpose: these are all things only a person looking at the
 * pictures knows, so they are set in one place, stored on the car, and beat
 * whatever the text suggests. "unknown" clears it and text reading takes over.
 */
export async function applyDrivetrainFact(
  db: Db,
  leadId: string,
  value: DrivetrainFactValue,
): Promise<{ overall: string }> {
  const stored = value === "unknown" ? null : value;
  return applyVerifiedFact(db, leadId, { drivetrain: stored }, "drivetrain_fact", { value });
}

/**
 * The one path for a fact the user verified by eye: write it on the LISTING,
 * re-evaluate with it, and leave an event. Every hand-set fact goes through
 * here so they cannot drift apart in what they store or audit.
 */
async function applyVerifiedFact(
  db: Db,
  leadId: string,
  patch: Partial<Pick<typeof listings.$inferSelect, "rhd" | "foreignPlates" | "drivetrain">>,
  eventType: string,
  eventPayload: Record<string, unknown>,
): Promise<{ overall: string }> {
  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) throw new Error(`lead ${leadId} not found`);

  await db.update(listings).set(patch).where(eq(listings.id, row.listing.id));

  const result = await reevaluateLead(
    db,
    row.lead,
    { ...row.listing, ...patch },
    row.brief,
    newEvalCaches(),
  );

  await db.insert(events).values({
    userId: row.lead.userId,
    leadId,
    type: eventType,
    payload: { ...eventPayload, overall: result.overall, outcome: result.outcome },
  });

  return { overall: result.overall };
}
