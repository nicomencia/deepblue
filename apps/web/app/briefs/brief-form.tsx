import type { briefs } from "@deepblue/db";
import { SubmitButton } from "../submit-button";

type BriefRow = typeof briefs.$inferSelect;

/**
 * One form for both lanes: create (no brief) and edit (prefilled from the
 * row, hidden id). Server component — the only client island is the submit
 * button. Field set mirrors BriefCriteria + HardLimits; notes and extra
 * vehicles have no fields here and are preserved by updateBrief.
 */
export function BriefForm({
  action,
  brief,
  submitLabel,
  pendingLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  brief?: BriefRow;
  submitLabel: string;
  pendingLabel: string;
}) {
  const c = brief?.criteria;
  const v = c?.vehicles[0];
  const h = brief?.hardLimits;
  return (
    <form action={action} style={{ ...card, display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
      {brief && <input type="hidden" name="id" value={brief.id} />}
      <label style={lbl}>
        Nombre (opcional)
        <input name="name" placeholder="Golf VII para diario" defaultValue={brief?.name} style={inp} />
      </label>
      <label style={lbl}>
        Marca *
        <input name="make" required placeholder="Volkswagen" defaultValue={v?.make} style={inp} />
      </label>
      <label style={lbl}>
        Modelo *
        <input name="model" required placeholder="Golf" defaultValue={v?.model} style={inp} />
      </label>
      <label style={lbl}>
        Año mínimo
        <input name="yearMin" type="number" placeholder="2015" defaultValue={c?.yearMin} style={inp} />
      </label>
      <label style={lbl}>
        Año máximo (unidades antiguas / una generación)
        <input name="yearMax" type="number" placeholder="1997" defaultValue={c?.yearMax} style={inp} />
      </label>
      <label style={lbl}>
        Generación (opcional — orienta el dossier)
        <input name="generation" placeholder="I (1980–1997)" defaultValue={v?.generations?.[0]} style={inp} />
      </label>
      <label style={lbl}>
        Km máximos
        <input name="kmMax" type="number" placeholder="140000" defaultValue={c?.kmMax} style={inp} />
      </label>
      <label style={lbl}>
        Precio máximo (€)
        <input name="maxPriceEur" type="number" placeholder="sin tope" defaultValue={h?.maxPriceEur} style={inp} />
        <small style={hint}>
          Vacío = sin tope: útil para ver a cuánto va un modelo que no conoces. Sin tope no se
          negocia ni se ofertan precios.
        </small>
      </label>
      <label style={lbl}>
        Precio objetivo (€)
        <input name="targetPriceEur" type="number" placeholder="13500" defaultValue={c?.targetPriceEur} style={inp} />
      </label>
      <label style={lbl}>
        Tolerancia al riesgo
        <select name="riskTolerance" defaultValue={c?.riskTolerance ?? "medium"} style={inp}>
          <option value="low">Baja — prioriza fiabilidad</option>
          <option value="medium">Media</option>
          <option value="high">Alta — prioriza precio</option>
        </select>
      </label>
      <label style={lbl}>
        Tipo de vendedor
        <select name="sellerPreference" defaultValue={c?.sellerPreference ?? "prefer_private"} style={inp}>
          <option value="prefer_private">Prefiero particulares / vendedores pequeños</option>
          <option value="any">Indiferente</option>
        </select>
      </label>
      <fieldset style={{ ...lbl, border: "none", padding: 0, margin: 0 }}>
        Combustible (vacío = cualquiera)
        <span style={{ display: "flex", gap: "0.8rem", marginTop: "0.3rem" }}>
          {(
            [
              ["gasoline", "Gasolina"],
              ["diesel", "Diésel"],
              ["hybrid", "Híbrido"],
            ] as const
          ).map(([value, text]) => (
            <label key={value}>
              <input type="checkbox" name="fuel" value={value} defaultChecked={c?.fuel?.includes(value)} /> {text}
            </label>
          ))}
        </span>
      </fieldset>
      <label style={lbl}>
        Radio de búsqueda (km)
        <input
          name="radiusKm"
          type="number"
          placeholder="toda España"
          defaultValue={c?.location?.radiusKm}
          style={inp}
        />
        <small style={hint}>Vacío = toda España. Ponle un radio solo si no quieres viajar.</small>
      </label>
      <label style={lbl}>
        Latitud / Longitud
        <span style={{ display: "flex", gap: "0.4rem" }}>
          <input name="lat" placeholder="40.4168" defaultValue={c?.location?.lat} style={inp} />
          <input name="lon" placeholder="-3.7038" defaultValue={c?.location?.lon} style={inp} />
        </span>
        <small style={hint}>Solo cuentan si hay radio.</small>
      </label>
      <label style={{ ...lbl, gridColumn: "1 / -1" }}>
        Innegociables (una por línea)
        <textarea
          name="nonNegotiables"
          rows={2}
          placeholder={"ITV en vigor\nSin reparaciones estructurales"}
          defaultValue={h?.nonNegotiables.join("\n")}
          style={inp}
        />
      </label>
      <fieldset style={{ border: "none", padding: 0, margin: 0, gridColumn: "1 / -1", display: "flex", gap: "1.2rem", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.85rem" }}>
          <input type="checkbox" name="noRhd" value="1" defaultChecked={h?.noRhd === true} /> Descartar volante a la derecha (RHD)
        </label>
        <label style={{ fontSize: "0.85rem" }}>
          <input type="checkbox" name="requireSpanishPlates" value="1" defaultChecked={h?.requireSpanishPlates === true} /> Descartar sin matricular en España
        </label>
      </fieldset>
      <label style={{ ...lbl, gridColumn: "1 / -1" }}>
        Notas para el agente (una por línea)
        <textarea
          name="notes"
          rows={2}
          placeholder={"Preferible pocos propietarios"}
          defaultValue={c?.notes?.join("\n")}
          style={inp}
        />
      </label>
      <div style={{ gridColumn: "1 / -1" }}>
        <SubmitButton
          label={submitLabel}
          pendingLabel={pendingLabel}
          style={{ ...btn, fontWeight: 600, padding: "0.5rem 1.2rem" }}
        />
      </div>
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
const hint: React.CSSProperties = { fontSize: "0.75rem", opacity: 0.75 };
const inp: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
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
