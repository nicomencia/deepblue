/**
 * Price diffing. Prices used to change silently: sweep re-sightings
 * overwrote the column and probes threw the number away. Now every observed
 * change is evented, the affected leads re-evaluate, and a DROP that lifts a
 * shortlisted lead over the alert bar emails the user — a price cut on a
 * good unit is exactly the "contacta hoy" moment the triage line waits for.
 */

import { composeUnitLine, gradeAtMost, type ConfidenceGrade, type ConfidenceVerdict } from "@deepblue/core";
import { briefs, events, leads, listings, users, type Db } from "@deepblue/db";
import { and, eq, notInArray } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

export interface PriceDrop {
  title: string;
  oldPriceEur: number;
  newPriceEur: number;
  verdict: ConfidenceVerdict;
  leadId: string;
}

/** Pure composer — tested without a DB. */
export function composePriceDropEmail(d: PriceDrop): { subject: string; text: string } {
  const drop = d.oldPriceEur - d.newPriceEur;
  const pct = Math.round((drop / d.oldPriceEur) * 100);
  return {
    subject: `deepblue · bajada de precio (−${drop.toLocaleString("es-ES")} €): ${d.title}`,
    text:
      `${d.title}\n` +
      `${d.oldPriceEur.toLocaleString("es-ES")} € → ${d.newPriceEur.toLocaleString("es-ES")} € (−${pct}%)\n\n` +
      `Confianza ${d.verdict.overall} · ${d.verdict.score}/100\n` +
      `Recomendación: ${composeUnitLine(d.verdict)}\n\n` +
      `Ficha: ${leadUrl(d.leadId)}`,
  };
}

export interface PriceChangeStats {
  changed: boolean;
  reevaluated: number;
  alerted: number;
}

/**
 * Apply one observed price change on a listing: event per active lead,
 * re-evaluate each, and email drops that now clear the alert bar (same
 * grade + score floor as instant alerts — selectivity is one policy).
 */
export async function applyPriceChange(
  db: Db,
  listingId: string,
  oldPriceEur: number | null | undefined,
  newPriceEur: number | null | undefined,
): Promise<PriceChangeStats> {
  if (oldPriceEur == null || newPriceEur == null || oldPriceEur === newPriceEur) {
    return { changed: false, reevaluated: 0, alerted: 0 };
  }

  const rows = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(and(eq(leads.listingId, listingId), notInArray(leads.state, ["dead", "handed_off"])));

  const caches = newEvalCaches();
  const stats: PriceChangeStats = { changed: true, reevaluated: 0, alerted: 0 };

  for (const row of rows) {
    await db.insert(events).values({
      userId: row.lead.userId,
      leadId: row.lead.id,
      type: "listing_price_changed",
      payload: { from: oldPriceEur, to: newPriceEur },
    });
    await reevaluateLead(
      db,
      row.lead,
      { ...row.listing, priceEur: newPriceEur },
      row.brief,
      caches,
    );
    stats.reevaluated += 1;

    if (newPriceEur >= oldPriceEur) continue;

    // Same bar as instant alerts: only the top of the band interrupts.
    const [fresh] = await db
      .select({ verdict: leads.verdict, state: leads.state })
      .from(leads)
      .where(eq(leads.id, row.lead.id))
      .limit(1);
    const v = fresh?.verdict;
    const alertThreshold = (process.env.ALERT_MAX_GRADE ?? "B") as ConfidenceGrade;
    const minScore = Number(process.env.ALERT_MIN_SCORE ?? 75);
    if (
      v &&
      fresh.state === "shortlisted" &&
      gradeAtMost(v.overall, alertThreshold) &&
      v.score >= minScore
    ) {
      const [owner] = await db.select().from(users).where(eq(users.id, row.lead.userId)).limit(1);
      if (owner) {
        await sendEmail({
          to: owner.email,
          ...composePriceDropEmail({
            title: row.listing.title,
            oldPriceEur,
            newPriceEur,
            verdict: v,
            leadId: row.lead.id,
          }),
        });
        await db.update(leads).set({ alertedAt: new Date() }).where(eq(leads.id, row.lead.id));
        stats.alerted += 1;
      }
    }
  }
  return stats;
}
