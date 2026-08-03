/**
 * Bridge from a lead row to the core visit checklist input: one place
 * decides the agreed price (code-decided, from the reading's observed
 * numbers) so the page and the auto-email always tell the same story.
 */

import { respondToCounterEur, type VisitChecklistInput } from "@deepblue/core";
import type { briefs, leads, listings } from "@deepblue/db";

type LeadRow = typeof leads.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;

/** The price the chat settled on, if the negotiation reached accept. */
export function agreedPriceEur(lead: LeadRow, brief: BriefRow): number | null {
  const neg = lead.chatReading?.negotiation;
  if (!neg?.ourLastOfferEur || !neg?.sellerLastOfferEur) return null;
  // No declared budget → nothing to accept against. The cap is the ONLY thing
  // stopping "accept" from agreeing to any number, so its absence must mean no
  // decision, never an unbounded one.
  const maxBudgetEur = brief.hardLimits.maxPriceEur;
  if (maxBudgetEur === undefined) return null;
  const decision = respondToCounterEur({
    ourLastOfferEur: neg.ourLastOfferEur,
    sellerCounterEur: neg.sellerLastOfferEur,
    maxBudgetEur,
  });
  return decision.action === "accept" ? decision.priceEur : null;
}

export function visitInputForLead(
  lead: LeadRow,
  listing: ListingRow,
  brief: BriefRow,
): VisitChecklistInput {
  return {
    title: listing.title,
    year: listing.year,
    km: listing.km,
    fuel: listing.fuel,
    gearbox: listing.gearbox,
    askingPriceEur: listing.cashPriceEur ?? listing.priceEur,
    agreedPriceEur: agreedPriceEur(lead, brief),
    maxBudgetEur: brief.hardLimits.maxPriceEur,
    issues: lead.verdict?.issues ?? [],
    findings: lead.issueFindings ?? [],
    redFlags: lead.chatReading?.redFlags ?? [],
    rhd: listing.rhd,
    foreignPlates: listing.foreignPlates,
  };
}
