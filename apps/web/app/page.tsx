import { briefs, leads, listings } from "@deepblue/db";
import { desc, eq, ne, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../lib/db";
import { fmtEur, fmtKm, gradeVar } from "../lib/ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = await getDb();

  const rows = await db
    .select({ lead: leads, listing: listings, briefName: briefs.name })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(ne(leads.state, "dead"))
    .orderBy(desc(sql`(${leads.verdict}->>'score')::int`), desc(leads.createdAt))
    .limit(200);

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
        {rows.length} lead{rows.length === 1 ? "" : "s"} activos, ordenados por puntuación
      </p>

      {rows.length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          Sin leads todavía. Crea una búsqueda en <Link href="/briefs">Búsquedas</Link> y
          arranca el runner (<code>pnpm dev:runner</code>).
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
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
                  <td style={td}>
                    <Link href={`/leads/${lead.id}`} style={{ textDecoration: "none" }}>
                      {listing.title}
                    </Link>
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
