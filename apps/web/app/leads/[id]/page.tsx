import { extractImportSignals, type IssueAssessment, type IssueFinding, type VerdictFactor } from "@deepblue/core";
import { briefs, events, leads, listings } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db";
import { fmtDate, fmtEur, fmtKm, gradeVar } from "../../../lib/ui";
import { setIssueFinding } from "./actions";

export const dynamic = "force-dynamic";

const FACTOR_NAMES: Record<string, string> = {
  priceFairness: "Precio justo",
  modelReliability: "Fiabilidad del modelo",
  unitEvidence: "Evidencia de la unidad",
  sellerCredibility: "Credibilidad del vendedor",
};

const STATUS_ES: Record<string, string> = {
  unconfirmed: "Pendiente",
  confirmed: "Confirmado",
  ruled_out: "Descartado",
};
/** Status colors: pending = attention, confirmed = bad news, ruled out = good. */
const STATUS_COLOR: Record<string, string> = {
  unconfirmed: "var(--grade-c)",
  confirmed: "var(--grade-e)",
  ruled_out: "var(--grade-a)",
};
const LIKELIHOOD_ES: Record<string, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};

export default async function LeadDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
  const v = lead.verdict;

  const history = await db
    .select()
    .from(events)
    .where(eq(events.leadId, lead.id))
    .orderBy(desc(events.createdAt))
    .limit(10);

  // High-signal import warnings belong next to the title, not buried in a card.
  const imported = extractImportSignals(listing.title, listing.description ?? undefined);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <p style={{ margin: "0 0 0.5rem" }}>
        <Link href="/" style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
          ← Leads
        </Link>
      </p>
      <h1 style={{ fontSize: "1.3rem", margin: "0 0 0.25rem" }}>{listing.title}</h1>
      {(imported.rhd || imported.foreignPlate) && (
        <p style={{ margin: "0.15rem 0 0.35rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {imported.foreignPlate && (
            <span style={importChip}>
              🇬🇧 Matrícula extranjera — rematriculación ~1.500 € (+aduanas/IVA si UK)
            </span>
          )}
          {imported.rhd && (
            <span style={importChip}>
              Volante a la derecha{imported.rhdAssumed ? " (asumido: origen inglés)" : " (RHD)"}
            </span>
          )}
        </p>
      )}
      {listing.imageUrl && (
        <a href={listing.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- platform CDN, unknown domains */}
          <img
            src={listing.imageUrl}
            alt={listing.title}
            style={{
              maxWidth: "100%",
              width: 420,
              borderRadius: 8,
              display: "block",
              margin: "0.5rem 0",
            }}
          />
        </a>
      )}
      <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
        {listing.cashPriceEur != null && listing.cashPriceEur !== listing.priceEur
          ? `${fmtEur(listing.cashPriceEur)} al contado (anuncio: ${fmtEur(listing.priceEur)})`
          : fmtEur(listing.priceEur)}{" "}
        · {listing.year ?? "año ?"} · {fmtKm(listing.km)} ·{" "}
        {listing.fuel ?? "?"} · {listing.gearbox ?? "cambio ?"}
        {listing.powerCv ? ` · ${listing.powerCv} CV` : ""} · {listing.locationText ?? "—"}
        {" · "}
        <a href={listing.url} target="_blank" rel="noreferrer">
          ver anuncio en {listing.platform} ↗
        </a>
      </p>
      <p style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
        Búsqueda: {brief.name} · Estado: <strong>{lead.state}</strong>
        {lead.state === "dead" && lead.deadReason ? ` (${lead.deadReason})` : ""}
        {lead.origin === "manual" ? " · adoptado manualmente" : ""}
        {listing.sellerName
          ? ` · Vendedor: ${listing.sellerName}${listing.sellerType === "dealer" ? " (profesional)" : ""}`
          : ""}
      </p>

      {lead.origin === "manual" && lead.state !== "dead" && lead.deadReason && (
        <p
          style={{
            border: "1px solid var(--grade-c)",
            color: "var(--grade-c)",
            borderRadius: 8,
            padding: "0.5rem 0.8rem",
            fontSize: "0.85rem",
          }}
        >
          No pasaría los filtros de esta búsqueda ({lead.deadReason}) — se mantiene vivo por
          adopción manual.
        </p>
      )}

      {v ? (
        <>
          {/* Verdict summary */}
          <section style={card}>
            <div style={{ display: "flex", gap: "2rem", alignItems: "baseline", flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: "2.2rem", fontWeight: 700, color: gradeVar(v.overall) }}>
                  {v.overall}
                </span>
                <span style={{ fontSize: "1.2rem", color: "var(--ink-muted)" }}> {v.score}/100</span>
              </div>
              <div style={{ color: "var(--ink-muted)" }}>
                {v.confidencePct}% verificado · actualizado {fmtDate(v.updatedAt)}
              </div>
            </div>
            {v.repairExposureEur && (
              <p style={{ marginBottom: 0 }}>
                Exposición en reparaciones sin descartar:{" "}
                <strong>
                  ~{v.repairExposureEur.min.toLocaleString("es-ES")}–
                  {v.repairExposureEur.max.toLocaleString("es-ES")} €
                </strong>
              </p>
            )}
            {v.budgetNote && <p style={{ marginBottom: 0 }}>{v.budgetNote}</p>}
          </section>

          {/* LLM read of the ad — refinement over the rule verdict */}
          {v.llm && (
            <section style={card}>
              <strong>Lectura del anuncio (IA)</strong>
              <p style={{ margin: "0.4rem 0" }}>{v.llm.summary}</p>
              {v.llm.redFlags.length > 0 && (
                <p style={{ margin: "0.35rem 0", fontSize: "0.87rem" }}>
                  <span style={{ color: "var(--grade-e)", fontWeight: 600 }}>Alertas:</span>{" "}
                  {v.llm.redFlags.join(" · ")}
                </p>
              )}
              {v.llm.greenFlags.length > 0 && (
                <p style={{ margin: "0.35rem 0", fontSize: "0.87rem" }}>
                  <span style={{ color: "var(--grade-a)", fontWeight: 600 }}>A favor:</span>{" "}
                  {v.llm.greenFlags.join(" · ")}
                </p>
              )}
              <p style={{ margin: "0.4rem 0 0", fontSize: "0.78rem", color: "var(--ink-muted)" }}>
                {v.llm.model} · {fmtDate(v.llm.at)}
              </p>
            </section>
          )}

          {/* Factors */}
          <h2 style={h2}>Factores</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "0.75rem" }}>
            {Object.entries(v.factors).map(([key, factor]) => (
              <FactorCard key={key} name={FACTOR_NAMES[key] ?? key} factor={factor} />
            ))}
          </div>

          {/* Issues */}
          {v.issues?.length > 0 && (
            <>
              <h2 style={h2}>Riesgos conocidos aplicables a esta unidad</h2>
              {v.issues.map((issue) => (
                <div key={issue.title} style={card}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.05rem 0.55rem",
                      marginRight: "0.5rem",
                      borderRadius: 999,
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: STATUS_COLOR[issue.status] ?? "var(--ink-muted)",
                      border: "1px solid currentcolor",
                      verticalAlign: "middle",
                    }}
                  >
                    {STATUS_ES[issue.status] ?? issue.status}
                  </span>
                  <strong>{issue.title}</strong>{" "}
                  <span style={{ color: "var(--ink-muted)" }}>
                    · probabilidad {LIKELIHOOD_ES[issue.likelihood] ?? issue.likelihood}
                    {issue.typicalRepairCostEur
                      ? ` · ~${issue.typicalRepairCostEur.min.toLocaleString("es-ES")}–${issue.typicalRepairCostEur.max.toLocaleString("es-ES")} €`
                      : ""}
                  </span>
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem", color: "var(--ink-muted)" }}>
                    Se descarta con: {issue.verifyBy.join("; ")}
                  </p>
                  <IssueControls
                    leadId={lead.id}
                    issue={issue}
                    finding={lead.issueFindings?.find((f) => f.title === issue.title)}
                  />
                </div>
              ))}
            </>
          )}

          {/* Seller questions */}
          {v.openQuestions.length > 0 && (
            <>
              <h2 style={h2}>Preguntas para el vendedor</h2>
              <ul style={{ lineHeight: 1.7 }}>
                {v.openQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          )}

          {/* What would raise the grade */}
          {v.wouldRaiseGrade.length > 0 && (
            <>
              <h2 style={h2}>Qué subiría la nota</h2>
              <ul style={{ lineHeight: 1.7, fontSize: "0.9rem" }}>
                {v.wouldRaiseGrade.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p style={{ color: "var(--ink-muted)" }}>Sin veredicto todavía.</p>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <h2 style={h2}>Historial</h2>
          <ul style={{ fontSize: "0.85rem", color: "var(--ink-muted)", lineHeight: 1.8 }}>
            {history.map((e) => (
              <li key={e.id}>
                {fmtDate(e.createdAt)} — {e.type}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function FactorCard({ name, factor }: { name: string; factor: VerdictFactor }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{name}</strong>
        <span>
          <span style={{ fontWeight: 700, color: gradeVar(factor.grade) }}>{factor.grade}</span>
          <span style={{ color: "var(--ink-muted)" }}> {factor.score ?? "—"}</span>
        </span>
      </div>
      {/* thin meter, rounded data-end, status color */}
      <div style={{ background: "var(--track)", borderRadius: 4, height: 6, margin: "0.5rem 0 0.75rem" }}>
        <div
          style={{
            width: `${factor.score ?? 0}%`,
            background: gradeVar(factor.grade),
            height: 6,
            borderRadius: 4,
          }}
        />
      </div>
      <FactList label="Sabemos" items={factor.known} />
      <FactList label="Asumimos" items={factor.assumed} />
      <FactList label="Sin verificar" items={factor.unverified} />
    </div>
  );
}

/**
 * The manual seller-verification loop: record what the seller proved (or
 * admitted) and the verdict re-evaluates on the spot. Phase 2 chat will feed
 * the same action automatically.
 */
function IssueControls({
  leadId,
  issue,
  finding,
}: {
  leadId: string;
  issue: IssueAssessment;
  finding?: IssueFinding;
}) {
  return (
    <form
      action={setIssueFinding}
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.6rem" }}
    >
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="title" value={issue.title} />
      {issue.status === "unconfirmed" ? (
        <>
          <input
            name="note"
            placeholder="Evidencia (factura, vídeo, diagnosis…)"
            style={{
              flex: "1 1 220px",
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "inherit",
              fontSize: "0.85rem",
            }}
          />
          <button type="submit" name="status" value="ruled_out" style={{ ...btn, color: "var(--grade-a)" }}>
            Descartar
          </button>
          <button type="submit" name="status" value="confirmed" style={{ ...btn, color: "var(--grade-e)" }}>
            Confirmar
          </button>
        </>
      ) : (
        <>
          {(finding?.note || finding?.at) && (
            <span style={{ color: "var(--ink-muted)", fontSize: "0.8rem" }}>
              {finding.note ? `Evidencia: ${finding.note}` : "Sin nota"}
              {finding.at ? ` · ${fmtDate(finding.at)}` : ""}
            </span>
          )}
          <button type="submit" name="status" value="unconfirmed" style={btn}>
            Reabrir
          </button>
        </>
      )}
    </form>
  );
}

function FactList({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <p style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
      <span style={{ color: "var(--ink-muted)" }}>{label}:</span>{" "}
      {items.map((i, n) => (
        <span key={i}>
          {n > 0 && " · "}
          {i}
        </span>
      ))}
    </p>
  );
}

const card: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.9rem 1rem",
  margin: "0.75rem 0",
};
const h2: React.CSSProperties = { fontSize: "1rem", margin: "1.5rem 0 0.5rem" };
const importChip: React.CSSProperties = {
  display: "inline-block",
  padding: "0.15rem 0.6rem",
  borderRadius: 999,
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--grade-d)",
  border: "1px solid currentcolor",
};
const btn: React.CSSProperties = {
  padding: "0.3rem 0.8rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
};
