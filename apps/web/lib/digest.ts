/**
 * Daily digest: refresh all shortlisted verdicts (benchmarks and dossiers
 * improve over time), then email each user their new candidates since the
 * last digest. Quiet days send nothing. Durable once-a-day guard via the
 * events log — safe across restarts and double-firing schedulers.
 */

import { briefs, events, leads, listings, users, type Db } from "@deepblue/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

const MAX_LISTED = 25;

type LeadRow = typeof leads.$inferSelect;
type ListingRow = typeof listings.$inferSelect;

export interface DigestResult {
  usersProcessed: number;
  digestsComposed: number;
}

const madridDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);

export async function runDigest(
  db: Db,
  opts: { force?: boolean } = {},
): Promise<DigestResult> {
  const owners = await db
    .selectDistinct({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(briefs, eq(briefs.userId, users.id))
    .where(eq(briefs.status, "active"));

  let composed = 0;
  for (const owner of owners) {
    const [lastRun] = await db
      .select({ at: events.createdAt })
      .from(events)
      .where(and(eq(events.userId, owner.id), eq(events.type, "digest_run")))
      .orderBy(desc(events.createdAt))
      .limit(1);
    // Once per Madrid calendar day, durable across restarts (force = dev only).
    if (!opts.force && lastRun && madridDate(lastRun.at) === madridDate(new Date())) continue;
    const windowStart = lastRun?.at ?? new Date(Date.now() - 24 * 3600 * 1000);

    // Refresh verdicts first so the digest reflects today's knowledge.
    const shortlisted = await db
      .select({ lead: leads, listing: listings, brief: briefs })
      .from(leads)
      .innerJoin(listings, eq(leads.listingId, listings.id))
      .innerJoin(briefs, eq(leads.briefId, briefs.id))
      .where(and(eq(leads.userId, owner.id), eq(leads.state, "shortlisted")));
    const caches = newEvalCaches();
    for (const row of shortlisted) {
      await reevaluateLead(db, row.lead, row.listing, row.brief, caches);
    }

    // New candidates in the window (re-query: re-evaluation may have killed some).
    const fresh = await db
      .select({ lead: leads, listing: listings })
      .from(leads)
      .innerJoin(listings, eq(leads.listingId, listings.id))
      .where(
        and(
          eq(leads.userId, owner.id),
          eq(leads.state, "shortlisted"),
          gte(leads.createdAt, windowStart),
        ),
      )
      .orderBy(asc(sql`${leads.verdict}->>'overall'`), asc(listings.priceEur));

    await db.insert(events).values({
      userId: owner.id,
      type: "digest_run",
      payload: { newLeads: fresh.length, windowStart: windowStart.toISOString() },
    });
    if (fresh.length === 0) continue;

    const { text, html } = composeDigest(fresh);
    const dateEs = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      day: "numeric",
      month: "long",
    }).format(new Date());
    await sendEmail({
      to: owner.email,
      subject: `deepblue · ${fresh.length} candidato${fresh.length === 1 ? "" : "s"} nuevo${fresh.length === 1 ? "" : "s"} — ${dateEs}`,
      text,
      html,
    });
    composed += 1;
  }

  return { usersProcessed: owners.length, digestsComposed: composed };
}

function leadSummary({ lead, listing }: { lead: LeadRow; listing: ListingRow }): string[] {
  const v = lead.verdict;
  const specs = [
    listing.priceEur != null ? `${listing.priceEur.toLocaleString("es-ES")} €` : "precio ?",
    listing.year ?? "año ?",
    listing.km != null ? `${listing.km.toLocaleString("es-ES")} km` : "km ?",
    listing.locationText,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`[${v?.overall ?? "?"}] ${listing.title} — ${specs}`];
  if (v?.repairExposureEur) {
    lines.push(
      `    Riesgos sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} € de exposición en reparaciones`,
    );
  }
  if (v?.budgetNote) lines.push(`    ${v.budgetNote}`);
  lines.push(`    ${listing.url}`);
  return lines;
}

function composeDigest(
  rows: Array<{ lead: LeadRow; listing: ListingRow }>,
): { text: string; html: string } {
  const listed = rows.slice(0, MAX_LISTED);
  const textBlocks = listed.map((r) => leadSummary(r).join("\n"));
  const more = rows.length > MAX_LISTED ? `\n…y ${rows.length - MAX_LISTED} más en el dashboard.` : "";
  const text = `Nuevos candidatos (${rows.length}):\n\n${textBlocks.join("\n\n")}${more}\n`;

  const htmlItems = listed
    .map((r) => {
      const [head, ...rest] = leadSummary(r);
      const detail = rest
        .filter((l) => !l.trim().startsWith("http"))
        .map((l) => `<br><small>${escapeHtml(l.trim())}</small>`)
        .join("");
      return `<li style="margin-bottom:12px"><a href="${r.listing.url}">${escapeHtml(head ?? "")}</a>${detail}</li>`;
    })
    .join("\n");
  const html = `<p>Nuevos candidatos (${rows.length}):</p><ul style="padding-left:16px">${htmlItems}</ul>${
    rows.length > MAX_LISTED ? `<p>…y ${rows.length - MAX_LISTED} más en el dashboard.</p>` : ""
  }`;

  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
