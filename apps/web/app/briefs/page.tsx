import { briefs, leads } from "@deepblue/db";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../lib/db";
import { fmtEur } from "../../lib/ui";
import { createBrief, deleteBrief, setBriefStatus } from "./actions";
import { ConfirmDelete } from "./confirm-delete";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
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
                  {c.riskTolerance ?? "medium"}
                  {brief.hardLimits.noRhd ? " · sin RHD" : ""}
                  {brief.hardLimits.requireSpanishPlates ? " · solo matrícula ES" : ""}
                  {" · "}
                  {shortlisted}/{total} leads vivos
                </p>
              </div>
              {/* One form per action: React server actions drop the submitter
                  button's own name/value, so status must be a hidden input. */}
              <span style={{ display: "flex", gap: "0.4rem", alignItems: "start" }}>
                <form action={setBriefStatus}>
                  <input type="hidden" name="id" value={brief.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={brief.status === "active" ? "paused" : "active"}
                  />
                  <button type="submit" style={btn}>
                    {brief.status === "active" ? "Pausar" : "Activar"}
                  </button>
                </form>
                <form action={deleteBrief}>
                  <input type="hidden" name="id" value={brief.id} />
                  <ConfirmDelete
                    style={btn}
                    message={`¿Eliminar «${brief.name}» y sus ${total} leads? Los anuncios del corpus se conservan. No se puede deshacer.`}
                  />
                </form>
              </span>
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
          <button type="submit" style={{ ...btn, fontWeight: 600, padding: "0.5rem 1.2rem" }}>
            Crear búsqueda
          </button>
        </div>
      </form>
    </main>
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
