import { briefs, leads, listings } from "@deepblue/db";
import { desc, eq, ne } from "drizzle-orm";
import { getDb } from "../lib/db";

export const dynamic = "force-dynamic";

const gradeColors: Record<string, string> = {
  A: "#1a7f37",
  B: "#4d8f2f",
  C: "#9a6700",
  D: "#bc4c00",
  E: "#cf222e",
};

export default async function Home() {
  const db = await getDb();

  const rows = await db
    .select({ lead: leads, listing: listings, briefName: briefs.name })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(ne(leads.state, "dead"))
    .orderBy(desc(leads.createdAt))
    .limit(200);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>deepblue</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        {rows.length} active lead{rows.length === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No leads yet. Seed a brief (<code>POST /api/dev/seed</code>), enqueue a sweep (
          <code>POST /api/dev/sweep</code>) and start the runner (<code>pnpm dev:runner</code>).
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #8884" }}>
                <th style={th}>Vehículo</th>
                <th style={th}>Precio</th>
                <th style={th}>Año</th>
                <th style={th}>Km</th>
                <th style={th}>Ubicación</th>
                <th style={th}>Estado</th>
                <th style={th}>Confianza</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ lead, listing }) => (
                <tr key={lead.id} style={{ borderBottom: "1px solid #8882" }}>
                  <td style={td}>
                    <a href={listing.url} target="_blank" rel="noreferrer">
                      {listing.title}
                    </a>
                  </td>
                  <td style={td}>
                    {listing.priceEur != null
                      ? `${listing.priceEur.toLocaleString("es-ES")} €`
                      : "—"}
                  </td>
                  <td style={td}>{listing.year ?? "—"}</td>
                  <td style={td}>
                    {listing.km != null ? listing.km.toLocaleString("es-ES") : "—"}
                  </td>
                  <td style={td}>{listing.locationText ?? "—"}</td>
                  <td style={td}>{lead.state}</td>
                  <td style={td}>
                    {lead.verdict ? (
                      <span
                        title={lead.verdict.wouldRaiseGrade.join("\n")}
                        style={{
                          fontWeight: 700,
                          color: gradeColors[lead.verdict.overall] ?? "inherit",
                        }}
                      >
                        {lead.verdict.overall}
                      </span>
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
