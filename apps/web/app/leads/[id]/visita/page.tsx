import { composeVisitChecklist } from "@deepblue/core";
import { briefs, leads, listings } from "@deepblue/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../../lib/db";
import { fmtEur, fmtKm } from "../../../../lib/ui";
import { visitInputForLead } from "../../../../lib/visit";

export const dynamic = "force-dynamic";

/**
 * The visit report: phone-friendly, printable, checkbox-per-line. Checkboxes
 * are plain HTML — ticking them is for the reader's eyes during the visit,
 * nothing is stored.
 */
export default async function VisitReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();

  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, id))
    .limit(1);
  if (!row) notFound();
  const { lead, listing, brief } = row;

  const input = visitInputForLead(lead, listing, brief);
  const sections = composeVisitChecklist(input);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      <p style={{ margin: "0 0 0.5rem" }}>
        <Link href={`/leads/${lead.id}`} style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
          ← Ficha del lead
        </Link>
      </p>
      <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.2rem" }}>📋 Informe de visita</h1>
      <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>{listing.title}</p>
      <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: "0.9rem" }}>
        {listing.year ?? "año ?"} · {fmtKm(listing.km)} · {listing.fuel ?? "?"} ·{" "}
        {listing.gearbox ?? "?"}
        {input.agreedPriceEur
          ? ` · acordado ${fmtEur(input.agreedPriceEur)}`
          : listing.priceEur != null
            ? ` · anuncio ${fmtEur(listing.priceEur)}`
            : ""}
      </p>

      {sections.map((section) => (
        <section key={section.title} style={{ margin: "1.25rem 0" }}>
          <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>{section.title}</h2>
          {section.items.map((item) => (
            <label
              key={item.check}
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "flex-start",
                padding: "0.45rem 0.6rem",
                border: "1px solid var(--border)",
                borderRadius: 8,
                marginBottom: "0.4rem",
                cursor: "pointer",
                fontSize: "0.92rem",
              }}
            >
              <input type="checkbox" style={{ marginTop: "0.2rem", flexShrink: 0 }} />
              <span>
                {item.check}
                {item.detail && (
                  <span
                    style={{
                      display: "block",
                      color: "var(--ink-muted)",
                      fontSize: "0.82rem",
                      marginTop: "0.15rem",
                    }}
                  >
                    {item.detail}
                  </span>
                )}
              </span>
            </label>
          ))}
        </section>
      ))}

      <p style={{ color: "var(--ink-muted)", fontSize: "0.8rem", margin: "1.5rem 0 0" }}>
        Generado desde el dossier, la conversación y la negociación de esta unidad. Las casillas no
        se guardan — son para la visita.
      </p>
    </main>
  );
}
