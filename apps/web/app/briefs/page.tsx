import { briefs, leads } from "@deepblue/db";
import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../../lib/db";
import { fmtEur } from "../../lib/ui";
import { adoptAd } from "../actions";
import { SubmitButton } from "../submit-button";
import { createBrief, deleteBrief, setBriefStatus, toggleBriefLimit } from "./actions";
import { ConfirmDelete } from "./confirm-delete";

export const dynamic = "force-dynamic";

export default async function BriefsPage({
  searchParams,
}: {
  searchParams: Promise<{ adopted?: string }>;
}) {
  const { adopted } = await searchParams;
  const db = await getDb();

  const rows = await db
    .select({
      brief: briefs,
      shortlisted: sql<number>`count(*) filter (where ${leads.state} = 'shortlisted')::int`,
      total: sql<number>`count(${leads.id})::int`,
    })
    .from(briefs)
    .leftJoin(leads, eq(leads.briefId, briefs.id))
    .groupBy(briefs.id)
    .orderBy(desc(briefs.createdAt));

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.2rem" }}>Búsquedas</h1>

      {adopted === "queued" && (
        <p style={{ ...banner, borderColor: "var(--grade-a)", color: "var(--grade-a)" }}>
          Anuncio en cola ✓ — el runner lo analizará en ~1 minuto y aparecerá como lead en{" "}
          <Link href="/">el panel</Link>. Progreso en <Link href="/activity">Actividad</Link>.
        </p>
      )}
      {adopted === "invalid" && (
        <p style={{ ...banner, borderColor: "var(--grade-e)", color: "var(--grade-e)" }}>
          URL no reconocida — pega el enlace completo de un anuncio de Wallapop
          (es.wallapop.com/item/…).
        </p>
      )}

      {/* Adopt a hand-found ad: analyzed, tracked and questioned like any lead */}
      <details style={{ ...card, padding: "0.6rem 0.9rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.9rem", fontWeight: 600 }}>
          ＋ Adoptar un anuncio que has encontrado tú
        </summary>
        <form
          action={adoptAd}
          style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.6rem" }}
        >
          <input
            name="url"
            required
            placeholder="https://es.wallapop.com/item/…"
            style={{ ...inp, width: "auto", flex: "2 1 320px" }}
          />
          <input
            name="maxPriceEur"
            placeholder="Tu precio máx (€)"
            style={{ ...inp, width: "auto", flex: "1 1 140px" }}
          />
          <select name="briefId" style={{ ...inp, width: "auto", flex: "1 1 160px" }} defaultValue="auto">
            <option value="auto">Búsqueda: automática</option>
            {rows.map(({ brief }) => (
              <option key={brief.id} value={brief.id}>
                {brief.name}
              </option>
            ))}
          </select>
          <SubmitButton
            label="Adoptar"
            pendingLabel="⏳ Adoptando…"
            style={{ ...btn, fontWeight: 600 }}
          />
        </form>
        <p style={{ color: "var(--ink-muted)", fontSize: "0.8rem", margin: "0.4rem 0 0" }}>
          El runner analizará el anuncio en su siguiente ciclo (~1 min); aparecerá como lead
          con veredicto completo y seguimiento de vida del anuncio.
        </p>
      </details>

      {rows.map(({ brief, shortlisted, total }) => {
        const c = brief.criteria;
        const v = c.vehicles[0];
        return (
          <div key={brief.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
              <div>
                <strong>{brief.name}</strong>{" "}
                <span style={{ color: "var(--ink-muted)" }}>· {brief.status}</span>
                <p style={{ margin: "0.3rem 0 0", fontSize: "0.87rem", color: "var(--ink-muted)" }}>
                  {v ? `${v.make} ${v.model}` : "—"}
                  {c.yearMin ? ` · desde ${c.yearMin}` : ""}
                  {c.kmMax ? ` · hasta ${c.kmMax.toLocaleString("es-ES")} km` : ""}
                  {" · máx "}
                  {fmtEur(brief.hardLimits.maxPriceEur)}
                  {c.targetPriceEur ? ` (objetivo ${fmtEur(c.targetPriceEur)})` : ""}
                  {" · riesgo "}
                  {c.riskTolerance ?? "medium"} · {shortlisted}/{total} leads vivos
                </p>
                {/* Import hard limits: toggling re-evaluates the brief's leads.
                    div, not p: a form may not nest inside a p (hydration error). */}
                <div style={{ margin: "0.4rem 0 0", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <LimitToggle
                    briefId={brief.id}
                    field="noRhd"
                    enabled={brief.hardLimits.noRhd === true}
                    label="RHD"
                  />
                  <LimitToggle
                    briefId={brief.id}
                    field="requireSpanishPlates"
                    enabled={brief.hardLimits.requireSpanishPlates === true}
                    label="Sin matricular en España"
                  />
                </div>
              </div>
              {/* One form per action: React server actions drop the submitter
                  button's own name/value, so status must be a hidden input. */}
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "start" }}>
                <form action={setBriefStatus}>
                  <input type="hidden" name="id" value={brief.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={brief.status === "active" ? "paused" : "active"}
                  />
                  <SubmitButton
                    label={brief.status === "active" ? "Pausar" : "Activar"}
                    style={btn}
                  />
                </form>
                <form action={deleteBrief}>
                  <input type="hidden" name="id" value={brief.id} />
                  <ConfirmDelete
                    style={btn}
                    message={`¿Eliminar «${brief.name}» y sus ${total} leads? Los anuncios del corpus se conservan. No se puede deshacer.`}
                  />
                </form>
              </div>
            </div>
          </div>
        );
      })}

      <h2 style={{ fontSize: "1rem", margin: "2rem 0 0.5rem" }}>Nueva búsqueda</h2>
      <form action={createBrief} style={{ ...card, display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <label style={lbl}>
          Nombre (opcional)
          <input name="name" placeholder="Golf VII para diario" style={inp} />
        </label>
        <label style={lbl}>
          Marca *
          <input name="make" required placeholder="Volkswagen" style={inp} />
        </label>
        <label style={lbl}>
          Modelo *
          <input name="model" required placeholder="Golf" style={inp} />
        </label>
        <label style={lbl}>
          Año mínimo
          <input name="yearMin" type="number" placeholder="2015" style={inp} />
        </label>
        <label style={lbl}>
          Km máximos
          <input name="kmMax" type="number" placeholder="140000" style={inp} />
        </label>
        <label style={lbl}>
          Precio máximo (€) *
          <input name="maxPriceEur" type="number" required placeholder="15500" style={inp} />
        </label>
        <label style={lbl}>
          Precio objetivo (€)
          <input name="targetPriceEur" type="number" placeholder="13500" style={inp} />
        </label>
        <label style={lbl}>
          Tolerancia al riesgo
          <select name="riskTolerance" defaultValue="medium" style={inp}>
            <option value="low">Baja — prioriza fiabilidad</option>
            <option value="medium">Media</option>
            <option value="high">Alta — prioriza precio</option>
          </select>
        </label>
        <label style={lbl}>
          Tipo de vendedor
          <select name="sellerPreference" defaultValue="prefer_private" style={inp}>
            <option value="prefer_private">Prefiero particulares / vendedores pequeños</option>
            <option value="any">Indiferente</option>
          </select>
        </label>
        <fieldset style={{ ...lbl, border: "none", padding: 0, margin: 0 }}>
          Combustible (vacío = cualquiera)
          <span style={{ display: "flex", gap: "0.8rem", marginTop: "0.3rem" }}>
            <label>
              <input type="checkbox" name="fuel" value="gasoline" /> Gasolina
            </label>
            <label>
              <input type="checkbox" name="fuel" value="diesel" /> Diésel
            </label>
            <label>
              <input type="checkbox" name="fuel" value="hybrid" /> Híbrido
            </label>
          </span>
        </fieldset>
        <label style={lbl}>
          Radio de búsqueda (km)
          <input name="radiusKm" type="number" placeholder="100" style={inp} />
        </label>
        <label style={lbl}>
          Latitud / Longitud
          <span style={{ display: "flex", gap: "0.4rem" }}>
            <input name="lat" placeholder="40.4168" style={inp} />
            <input name="lon" placeholder="-3.7038" style={inp} />
          </span>
        </label>
        <label style={{ ...lbl, gridColumn: "1 / -1" }}>
          Innegociables (una por línea)
          <textarea name="nonNegotiables" rows={2} placeholder={"ITV en vigor\nSin reparaciones estructurales"} style={inp} />
        </label>
        <fieldset style={{ border: "none", padding: 0, margin: 0, gridColumn: "1 / -1", display: "flex", gap: "1.2rem", flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.85rem" }}>
            <input type="checkbox" name="noRhd" value="1" /> Descartar volante a la derecha (RHD)
          </label>
          <label style={{ fontSize: "0.85rem" }}>
            <input type="checkbox" name="requireSpanishPlates" value="1" /> Descartar sin matricular en España
          </label>
        </fieldset>
        <label style={{ ...lbl, gridColumn: "1 / -1" }}>
          Notas para el agente (una por línea)
          <textarea name="notes" rows={2} placeholder={"Preferible pocos propietarios"} style={inp} />
        </label>
        <div style={{ gridColumn: "1 / -1" }}>
          <SubmitButton
            label="Crear búsqueda"
            pendingLabel="⏳ Creando búsqueda…"
            style={{ ...btn, fontWeight: 600, padding: "0.5rem 1.2rem" }}
          />
        </div>
      </form>
    </main>
  );
}

/** One import hard limit as a toggle chip: enabled = veto active (red). */
function LimitToggle({
  briefId,
  field,
  enabled,
  label,
}: {
  briefId: string;
  field: "noRhd" | "requireSpanishPlates";
  enabled: boolean;
  label: string;
}) {
  return (
    <form action={toggleBriefLimit} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={briefId} />
      <input type="hidden" name="field" value={field} />
      <button
        type="submit"
        title={enabled ? "Veto activo — clic para aceptar" : "Se acepta — clic para vetar"}
        style={{
          padding: "0.1rem 0.6rem",
          borderRadius: 999,
          border: "1px solid",
          borderColor: enabled ? "var(--grade-e)" : "var(--border)",
          background: "transparent",
          color: enabled ? "var(--grade-e)" : "var(--ink-muted)",
          fontWeight: enabled ? 700 : 400,
          fontSize: "0.78rem",
          cursor: "pointer",
        }}
      >
        {enabled ? `✕ ${label}: vetado` : `${label}: se acepta`}
      </button>
    </form>
  );
}

const card: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.9rem 1rem",
  margin: "0.6rem 0",
};
const lbl: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.85rem",
  color: "var(--ink-muted)",
};
const inp: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  width: "100%",
  boxSizing: "border-box",
};
const btn: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  fontSize: "0.85rem",
};
const banner: React.CSSProperties = {
  border: "1px solid",
  borderRadius: 8,
  padding: "0.5rem 0.8rem",
  fontSize: "0.85rem",
  margin: "0 0 1rem",
};
