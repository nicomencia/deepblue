/**
 * Daily digest: refresh all shortlisted verdicts (benchmarks and dossiers
 * improve over time), then email each user their new candidates since the
 * last digest. Quiet days send nothing. Durable once-a-day guard via the
 * events log — safe across restarts and double-firing schedulers.
 */

import { composeUnitLine, gradeAtMost, type ConfidenceGrade } from "@deepblue/core";
import { briefs, events, leads, listings, users, type Db } from "@deepblue/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { leadUrl } from "./links";
import { newEvalCaches, reevaluateLead } from "./reevaluate";

/**
 * Cap per SEARCH, not per email: with several briefs running, a global cap let
 * one prolific search eat the whole digest and hide the others entirely. Each
 * search now shows its own best and says how many it is holding back.
 */
const MAX_PER_BRIEF = 10;
/** Worst grade the digest bothers emailing; D/E stay on the dashboard only. */
const DIGEST_FLOOR = (process.env.DIGEST_MAX_GRADE ?? "C") as ConfidenceGrade;

type LeadRow = typeof leads.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;

export interface DigestRow {
  lead: LeadRow;
  listing: ListingRow;
  brief: BriefRow;
}

/** One search's slice of the digest, its rows already best-score-first. */
interface DigestSection {
  briefName: string;
  rows: DigestRow[];
}

const scoreOf = (r: DigestRow): number => r.lead.verdict?.score ?? 0;

/**
 * One section per search, each ordered by score, sections led by the search
 * holding the single best candidate — that is the one worth reading first.
 */
export function groupByBrief(rows: DigestRow[]): DigestSection[] {
  const groups = new Map<string, DigestSection>();
  for (const row of rows) {
    const section = groups.get(row.brief.id) ?? { briefName: row.brief.name, rows: [] };
    section.rows.push(row);
    groups.set(row.brief.id, section);
  }
  for (const section of groups.values()) section.rows.sort((a, b) => scoreOf(b) - scoreOf(a));
  return [...groups.values()].sort((a, b) => scoreOf(b.rows[0]!) - scoreOf(a.rows[0]!));
}

export interface DigestResult {
  usersProcessed: number;
  digestsComposed: number;
}

const madridDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);

/**
 * Leads that became candidates inside the window, ordered by the NUMERIC score
 * rather than the grade letter — a whole band of "C" said nothing about which C
 * to open first. Shared with the dev preview route so what you preview is
 * exactly what would be sent.
 */
export async function newCandidates(
  db: Db,
  userId: string,
  windowStart: Date,
): Promise<DigestRow[]> {
  return db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(
      and(eq(leads.userId, userId), eq(leads.state, "shortlisted"), gte(leads.createdAt, windowStart)),
    )
    .orderBy(desc(sql`coalesce((${leads.verdict}->>'score')::int, 0)`), asc(listings.priceEur));
}

/** Start of the window the next digest would cover, without consuming it. */
export async function digestWindowStart(db: Db, userId: string): Promise<Date> {
  const [lastRun] = await db
    .select({ at: events.createdAt })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.type, "digest_run")))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return lastRun?.at ?? new Date(Date.now() - 24 * 3600 * 1000);
}

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

    // Re-query: re-evaluation may have killed some.
    const fresh = await newCandidates(db, owner.id, windowStart);

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

  // Grade AND score: the letter bands five points into one bucket, so a list of
  // Cs needs the number to be sortable by eye.
  const badge = v ? `[${v.overall} · ${v.score}]` : "[?]";
  const lines = [`${badge} ${listing.title} — ${specs}`];
  // The triage phrase first: pursue this one or wait for the next.
  if (v) lines.push(`    → ${composeUnitLine(v)}`);
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

export function composeDigest(rows: DigestRow[]): { text: string; html: string } {
  const sections = groupByBrief(rows);
  const heading = `Nuevos candidatos (${rows.length}) en ${sections.length} búsqueda${
    sections.length === 1 ? "" : "s"
  }`;

  const held = (s: DigestSection): number => Math.max(0, s.rows.length - MAX_PER_BRIEF);

  const textParts = sections.map((s) => {
    const listed = s.rows.slice(0, MAX_PER_BRIEF);
    const blocks = listed.map((r) => leadSummary(r).join("\n")).join("\n\n");
    const more = held(s) ? `\n\n  …y ${held(s)} más de esta búsqueda en el dashboard.` : "";
    return `${s.briefName} (${s.rows.length})\n${"─".repeat(s.briefName.length + 6)}\n\n${blocks}${more}`;
  });
  const text = `${heading}:\n\n${textParts.join("\n\n\n")}\n`;

  const htmlSections = sections
    .map((s) => {
      const items = s.rows
        .slice(0, MAX_PER_BRIEF)
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
      const more = held(s)
        ? `<p style="margin:4px 0 0"><small>…y ${held(s)} más de esta búsqueda en el dashboard.</small></p>`
        : "";
      return `<h3 style="margin:24px 0 4px;padding-bottom:4px;border-bottom:1px solid #ddd">${escapeHtml(
        s.briefName,
      )} <small style="font-weight:normal;color:#666">(${s.rows.length})</small></h3><ul style="padding-left:16px;margin-top:8px">${items}</ul>${more}`;
    })
    .join("\n");
  const html = `<p>${escapeHtml(heading)}:</p>${htmlSections}`;

  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
