import { composeTriageLine } from "@deepblue/core";
import { briefs, leads, listings } from "@deepblue/db";
import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../lib/db";
import { fmtEur, fmtKm, gradeVar } from "../lib/ui";
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ brief?: string }>;
}) {
  const db = await getDb();
  const { brief: briefParam } = await searchParams;

  const allBriefs = await db
    .select({ id: briefs.id, name: briefs.name })
    .from(briefs)
    .orderBy(asc(briefs.createdAt));
  // Unknown/stale ids fall back to the all-briefs view rather than a dead page.
  const activeBrief = allBriefs.find((b) => b.id === briefParam);

  const countRows = await db
    .select({ briefId: leads.briefId, n: count() })
    .from(leads)
    .where(ne(leads.state, "dead"))
    .groupBy(leads.briefId);
  const countByBrief = new Map(countRows.map((r) => [r.briefId, Number(r.n)]));
  const totalActive = [...countByBrief.values()].reduce((a, b) => a + b, 0);

  const rows = await db
    .select({ lead: leads, listing: listings, briefName: briefs.name })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(
      activeBrief
        ? and(ne(leads.state, "dead"), eq(leads.briefId, activeBrief.id))
        : ne(leads.state, "dead"),
    )
    .orderBy(desc(sql`(${leads.verdict}->>'score')::int`), desc(leads.createdAt))
    .limit(200);

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "2rem 1.5rem" }}>
      {allBriefs.length > 1 && (
        <nav style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <Link href="/" style={tab(!activeBrief)}>
            Todas <span style={tabCount}>{totalActive}</span>
          </Link>
          {allBriefs.map((b) => (
            <Link key={b.id} href={`/?brief=${b.id}`} style={tab(activeBrief?.id === b.id)}>
              {b.name} <span style={tabCount}>{countByBrief.get(b.id) ?? 0}</span>
            </Link>
          ))}
        </nav>
      )}

      <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
        {rows.length} lead{rows.length === 1 ? "" : "s"} activos
        {activeBrief ? ` en «${activeBrief.name}»` : ""}, ordenados por puntuación
      </p>

      {rows.length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          Sin leads todavía{activeBrief ? " en esta búsqueda" : ""}. Crea una búsqueda en{" "}
          <Link href="/briefs">Búsquedas</Link> y arranca el runner (
          <code>pnpm dev:runner</code>).
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
                <th style={{ ...th, width: 76 }} aria-label="Foto"></th>
                <th style={th}>Vehículo</th>
                <th style={th}>Precio</th>
                <th style={th}>Año</th>
                <th style={th}>Km</th>
                <th style={th}>Ubicación</th>
                <th style={th}>Plataforma</th>
                <th style={th}>Confianza</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ lead, listing }) => (
                <tr key={lead.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ ...td, padding: "0.35rem 0.75rem 0.35rem 0" }}>
                    {listing.imageUrl && (
                      <Link href={`/leads/${lead.id}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- platform CDN, unknown domains */}
                        <img
                          src={listing.imageUrl}
                          alt=""
                          width={68}
                          height={51}
                          loading="lazy"
                          style={{ objectFit: "cover", borderRadius: 6, display: "block" }}
                        />
                      </Link>
                    )}
                  </td>
                  <td style={td}>
                    <Link href={`/leads/${lead.id}`} style={{ textDecoration: "none" }}>
                      {listing.title}
                    </Link>
                    {lead.verdict && (
                      <span
                        style={{
                          display: "block",
                          color: "var(--ink-muted)",
                          fontSize: "0.78rem",
                          marginTop: "0.15rem",
                        }}
                      >
                        {composeTriageLine(lead.verdict)}
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {listing.cashPriceEur != null && listing.cashPriceEur !== listing.priceEur ? (
                      <>
                        {fmtEur(listing.cashPriceEur)}{" "}
                        <span style={{ color: "var(--ink-muted)", fontSize: "0.8rem" }}>
                          (anuncio: {fmtEur(listing.priceEur)})
                        </span>
                      </>
                    ) : (
                      fmtEur(listing.priceEur)
                    )}
                  </td>
                  <td style={td}>{listing.year ?? "—"}</td>
                  <td style={td}>{fmtKm(listing.km)}</td>
                  <td style={td}>{listing.locationText ?? "—"}</td>
                  <td style={{ ...td, color: "var(--ink-muted)" }}>{listing.platform}</td>
                  <td style={td}>
                    {lead.verdict ? (
                      <>
                        <span style={{ fontWeight: 700, color: gradeVar(lead.verdict.overall) }}>
                          {lead.verdict.overall}
                        </span>
                        {lead.verdict.score != null && (
                          <span style={{ color: "var(--ink-muted)" }}>
                            {" "}
                            {lead.verdict.score} · {lead.verdict.confidencePct}% verif.
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 0.75rem" };
const td: React.CSSProperties = { padding: "0.5rem 0.75rem" };

const tab = (active: boolean): React.CSSProperties => ({
  padding: "0.3rem 0.85rem",
  borderRadius: 999,
  textDecoration: "none",
  fontSize: "0.85rem",
  fontWeight: active ? 700 : 400,
  color: "inherit",
  background: active ? "var(--card)" : "transparent",
  border: `1px solid ${active ? "var(--ink-muted)" : "var(--border)"}`,
});

const tabCount: React.CSSProperties = { color: "var(--ink-muted)", fontWeight: 400 };

