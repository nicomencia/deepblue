/**
 * Daily digest: refresh all shortlisted verdicts (benchmarks and dossiers
 * improve over time), then email each user their new candidates since the
 * last digest. Quiet days send nothing. Durable once-a-day guard via the
 * events log — safe across restarts and double-firing schedulers.
 */

import { composeTriageLine, gradeAtMost, type ConfidenceGrade } from "@deepblue/core";
import { briefs, events, leads, listings, users, type Db } from "@deepblue/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

const MAX_LISTED = 25;
/** Worst grade the digest bothers emailing; D/E stay on the dashboard only. */
const DIGEST_FLOOR = (process.env.DIGEST_MAX_GRADE ?? "C") as ConfidenceGrade;

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

    // Email-worthy only: at least DIGEST_FLOOR. Already-alerted leads stay in
    // as a labeled recap — the digest is the complete daily picture even for
    // users who ignore instant alerts. Below-floor stays dashboard-only.
    const mailable = fresh.filter(
      (r) => r.lead.verdict != null && gradeAtMost(r.lead.verdict.overall, DIGEST_FLOOR),
    );

    await db.insert(events).values({
      userId: owner.id,
      type: "digest_run",
      payload: {
        newLeads: mailable.length,
        belowFloor: fresh.length - mailable.length,
        windowStart: windowStart.toISOString(),
      },
    });
    if (mailable.length === 0) continue;

    const { text, html } = composeDigest(mailable);
    const dateEs = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      day: "numeric",
      month: "long",
    }).format(new Date());
    await sendEmail({
      to: owner.email,
      subject: `deepblue · ${mailable.length} candidato${mailable.length === 1 ? "" : "s"} nuevo${mailable.length === 1 ? "" : "s"} — ${dateEs}`,
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
  // The triage phrase first: pursue this one or wait for the next.
  if (v) lines.push(`    → ${composeTriageLine(v)}`);
  if (lead.alertedAt) {
    const when = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(lead.alertedAt);
    lines.push(`    Ya avisado por alerta (${when})`);
  }
  if (v?.repairExposureEur) {
    lines.push(
      `    Riesgos sin verificar: ~${v.repairExposureEur.min.toLocaleString("es-ES")}–${v.repairExposureEur.max.toLocaleString("es-ES")} € de exposición en reparaciones`,
    );
  }
  if (v?.budgetNote) lines.push(`    ${v.budgetNote}`);
  lines.push(`    Ficha en deepblue: ${leadUrl(lead.id)}`);
  lines.push(`    Anuncio: ${listing.url}`);
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
      // Link lines are rendered as anchors below, not repeated as text.
      const detail = rest
        .filter((l) => !l.includes("http"))
        .map((l) => `<br><small>${escapeHtml(l.trim())}</small>`)
        .join("");
      // The headline is the action: it opens the lead's page in deepblue
      // (verdict, findings, approvals); the raw ad is the secondary link.
      const photo = r.listing.imageUrl
        ? `<br><a href="${leadUrl(r.lead.id)}"><img src="${r.listing.imageUrl}" alt="" width="280" style="max-width:100%;border-radius:6px;margin-top:6px"></a>`
        : "";
      return `<li style="margin-bottom:16px"><a href="${leadUrl(r.lead.id)}">${escapeHtml(head ?? "")}</a>${detail}${photo}<br><small><a href="${r.listing.url}">anuncio original</a></small></li>`;
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
