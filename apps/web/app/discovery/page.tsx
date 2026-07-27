import { ECO_LABELS, normalizeImageUrl } from "@deepblue/core";
import { briefs, discoveries } from "@deepblue/db";
import { desc, ne } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../../lib/db";
import { briefNameForRecommendation } from "../../lib/discovery";
import { modelPhotoKey, resolveModelPhotos } from "../../lib/model-photo";
import { isLlmConfigured } from "../../lib/llm";
import { fmtDate, fmtEur } from "../../lib/ui";
import { ActionForm } from "../action-form";
import { SubmitButton } from "../submit-button";
import {
  analyzeDiscovery,
  archiveDiscovery,
  createBriefFromRecommendation,
  createDiscovery,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function DiscoveryPage() {
  const db = await getDb();
  const llmReady = isLlmConfigured();
  const sessions = await db
    .select()
    .from(discoveries)
    .where(ne(discoveries.status, "archived"))
    .orderBy(desc(discoveries.createdAt));

  // Live brief names → mark recommendations that already became a búsqueda
  // ("Crear búsqueda" turns into a link; re-clicks can't duplicate).
  const liveBriefs = await db
    .select({ name: briefs.name })
    .from(briefs)
    .where(ne(briefs.status, "archived"));
  const liveBriefNames = new Set(liveBriefs.map((b) => b.name));

  // Research emits a photo for some recommendations and not others — it has 12
  // searches to spend and prices matter more than pictures, so it drops the
  // field rather than inventing a URL (asked for it, got 1 of 4 on 2026-07-27).
  // Same free fallback the other lists use, so a card is never faceless.
  const recPhotos = await resolveModelPhotos(
    db,
    sessions.flatMap((s) =>
      (s.report?.recommendations ?? []).map((rec) => ({
        make: rec.make,
        model: rec.model,
        generation: rec.generation,
      })),
    ),
  );

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.2rem", marginBottom: "0.25rem" }}>Descubrir mi coche</h1>
      <p style={{ color: "var(--ink-muted)", marginTop: 0, fontSize: "0.9rem" }}>
        ¿No sabes qué modelo buscar? Describe lo que necesitas y el asesor investiga el
        mercado español y te propone modelos concretos — cada recomendación se convierte
        en una búsqueda con un clic.
      </p>

      {/* Intake form */}
      <ActionForm action={createDiscovery} style={{ ...card, display: "grid", gap: "0.6rem" }}>
        <strong>Nuevo perfil de búsqueda</strong>
        <div style={grid2}>
          <label style={lbl}>
            Presupuesto (€) *
            <input name="budgetEur" required placeholder="8.000" style={input} />
          </label>
          <label style={lbl}>
            Km al año
            <input name="kmPerYear" placeholder="12.000" style={input} />
          </label>
        </div>
        <label style={lbl}>
          ¿Para qué lo quieres? *
          <input
            name="usage"
            required
            placeholder="diario ciudad + viajes de finde, algo divertido…"
            style={input}
          />
        </label>
        <div style={grid2}>
          <label style={lbl}>
            Plazas mínimas
            <input name="seatsMin" placeholder="4" style={input} />
          </label>
          <label style={lbl}>
            Cambio
            <select name="gearbox" style={input} defaultValue="any">
              <option value="any">Indiferente</option>
              <option value="manual">Manual</option>
              <option value="automatic">Automático</option>
            </select>
          </label>
        </div>
        <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--ink-muted)" }}>Combustible:</span>
          {(["gasoline", "diesel", "hybrid", "electric"] as const).map((f) => (
            <label key={f} style={{ fontSize: "0.85rem" }}>
              <input type="checkbox" name="fuel" value={f} />{" "}
              {{ gasoline: "Gasolina", diesel: "Diésel", hybrid: "Híbrido", electric: "Eléctrico" }[f]}
            </label>
          ))}
        </fieldset>
        <div style={grid2}>
          <label style={lbl}>
            Prioridades (una por línea)
            <textarea name="priorities" rows={3} placeholder={"fiabilidad\ndiversión\ncoste de uso"} style={input} />
          </label>
          <label style={lbl}>
            Imprescindibles (una por línea)
            <textarea name="mustHaves" rows={3} placeholder={"etiqueta C o mejor\nIsofix"} style={input} />
          </label>
        </div>
        <label style={lbl}>
          Descartes (una por línea)
          <textarea name="dealBreakers" rows={2} placeholder={"nada de SUV\nni renting ni compraventas"} style={input} />
        </label>

        {/* Optional limits. They steer the recommendation AND are inherited by
            every búsqueda created from it, so they are not typed twice. */}
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "0.6rem 0.8rem", display: "grid", gap: "0.6rem" }}>
          <legend style={{ fontSize: "0.8rem", color: "var(--ink-muted)", padding: "0 0.3rem" }}>
            Límites (opcional) — afinan la recomendación y se heredan en la búsqueda
          </legend>
          <div style={grid2}>
            <label style={lbl}>
              Año mínimo
              <input name="yearMin" placeholder="2010" style={input} />
            </label>
            <label style={lbl}>
              Año máximo
              <input name="yearMax" placeholder="2018" style={input} />
            </label>
          </div>
          <div style={grid2}>
            <label style={lbl}>
              Km máximos
              <input name="kmMax" placeholder="150.000" style={input} />
            </label>
            <label style={lbl}>
              Etiqueta DGT mínima
              <select name="ecoLabelMin" style={input} defaultValue="">
                <option value="">Indiferente</option>
                {ECO_LABELS.map((e) => (
                  <option key={e} value={e}>
                    {e === "0" ? "0 (cero emisiones)" : e}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", fontSize: "0.85rem" }}>
            <label>
              <input type="checkbox" name="noRhd" value="1" /> Descartar volante a la derecha
            </label>
            <label>
              <input type="checkbox" name="requireSpanishPlates" value="1" /> Solo matriculados en España
            </label>
          </div>
        </fieldset>

        {/* Search settings: they don't change WHICH models get recommended,
            only how the resulting búsqueda hunts. Kept out of the prompt. */}
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "0.6rem 0.8rem", display: "grid", gap: "0.6rem" }}>
          <legend style={{ fontSize: "0.8rem", color: "var(--ink-muted)", padding: "0 0.3rem" }}>
            Ajustes de la búsqueda (opcional) — no cambian la recomendación
          </legend>
          <div style={grid2}>
            <label style={lbl}>
              Tolerancia al riesgo
              <select name="riskTolerance" style={input} defaultValue="medium">
                <option value="low">Baja — prima la fiabilidad</option>
                <option value="medium">Media</option>
                <option value="high">Alta — prima el precio</option>
              </select>
            </label>
            <label style={lbl}>
              Tipo de vendedor
              <select name="sellerPreference" style={input} defaultValue="prefer_private">
                <option value="prefer_private">Prefiero particulares</option>
                <option value="any">Indiferente</option>
              </select>
            </label>
          </div>
          <label style={lbl}>
            Radio de búsqueda (km) — vacío = toda España
            <input name="radiusKm" placeholder="toda España" style={input} />
          </label>
          <div style={grid2}>
            <label style={lbl}>
              Latitud (solo si pones radio)
              <input name="lat" placeholder="40.4168" style={input} />
            </label>
            <label style={lbl}>
              Longitud (solo si pones radio)
              <input name="lon" placeholder="-3.7038" style={input} />
            </label>
          </div>
        </fieldset>
        <label style={lbl}>
          Notas libres
          <textarea name="notes" rows={2} placeholder="tuve un Golf y me encantó, aparco en la calle…" style={input} />
        </label>
        <div>
          <SubmitButton label="Crear perfil" pendingLabel="⏳ Creando…" style={btn} />
        </div>
      </ActionForm>

      {/* Sessions */}
      {sessions.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>
              {fmtEur(s.profile.budgetEur)} · {s.profile.usage}
            </strong>
            <span style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
              {fmtDate(s.createdAt)}
              {s.status === "ready" && s.reportSource ? ` · informe de ${s.reportSource}` : ""}
            </span>
          </div>

          {/* In flight: the run survives a refresh, so the page must say so
              instead of offering a button that would buy a second one. */}
          {s.status === "analyzing" && (
            <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem", color: "var(--grade-c)", fontWeight: 600 }}>
              ⏳ Analizando… — tarda unos minutos. Puedes cerrar la página: el
              análisis sigue en el servidor y aparecerá aquí al recargar.
            </p>
          )}

          {s.status === "pending" && (
            <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              {llmReady ? (
                <ActionForm action={analyzeDiscovery}>
                  <input type="hidden" name="id" value={s.id} />
                  <SubmitButton
                    label="Analizar con IA"
                    pendingLabel="⏳ Analizando… (tarda unos minutos)"
                    style={btn}
                  />
                </ActionForm>
              ) : (
                <span style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
                  Sin API key: pide el análisis en tu sesión de Claude Code («analiza mi
                  perfil de descubrimiento») y el informe aparecerá aquí.
                </span>
              )}
              <form action={archiveDiscovery}>
                <input type="hidden" name="id" value={s.id} />
                <SubmitButton label="Archivar" style={{ ...btn, opacity: 0.7 }} />
              </form>
            </div>
          )}

          {s.status === "ready" && s.report && (
            <>
              <p style={{ margin: "0.6rem 0", fontSize: "0.9rem" }}>{s.report.headline}</p>
              {s.report.recommendations.map((rec, i) => (
                <div key={`${rec.make}-${rec.model}`} style={{ ...card, margin: "0.6rem 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong>
                      {rec.make} {rec.model}
                      {rec.yearMin || rec.yearMax
                        ? ` (${rec.yearMin ?? "…"}–${rec.yearMax ?? "…"})`
                        : ""}
                    </strong>
                    <span style={{ color: "var(--ink-muted)" }}>
                      {fmtEur(rec.priceBandEur.min)}–{fmtEur(rec.priceBandEur.max)}
                    </span>
                  </div>
                  {(() => {
                    // Researched art first — it is specific to the generation
                    // being recommended. The fallback is repaired on read too:
                    // reports stored before the URL fix hold Wikimedia *page*
                    // URLs, and they should show a photo without re-running
                    // minutes of paid research.
                    const src =
                      normalizeImageUrl(rec.imageUrl) ??
                      recPhotos.get(modelPhotoKey(rec.make, rec.model));
                    return src ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external research URL, unknown domains
                      <img
                        src={src}
                        alt={`${rec.make} ${rec.model}`}
                        loading="lazy"
                        style={{
                          maxWidth: "100%",
                          width: 340,
                          borderRadius: 6,
                          display: "block",
                          margin: "0.5rem 0 0.25rem",
                        }}
                      />
                    ) : null;
                  })()}
                  <List label="Buscar" items={rec.versions} />
                  <List label="Evitar" items={rec.avoidVersions} />
                  <List label="Por qué encaja" items={rec.whyFits} />
                  <List label="Vigilar" items={rec.watchouts} />
                  {liveBriefNames.has(briefNameForRecommendation(rec)) ? (
                    <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--grade-a)", fontWeight: 600 }}>
                      ✓ Búsqueda creada — <Link href="/briefs">ver búsquedas</Link>
                    </p>
                  ) : (
                    <form action={createBriefFromRecommendation} style={{ marginTop: "0.5rem" }}>
                      <input type="hidden" name="discoveryId" value={s.id} />
                      <input type="hidden" name="index" value={i} />
                      <SubmitButton
                        label="Crear búsqueda"
                        pendingLabel="⏳ Creando búsqueda…"
                        style={btn}
                      />
                    </form>
                  )}
                </div>
              ))}
              {s.report.discarded.length > 0 && (
                <p style={{ fontSize: "0.85rem", color: "var(--ink-muted)" }}>
                  Descartados:{" "}
                  {s.report.discarded.map((d) => `${d.model} (${d.reason})`).join(" · ")}
                </p>
              )}
              <form action={archiveDiscovery}>
                <input type="hidden" name="id" value={s.id} />
                <SubmitButton label="Archivar" style={{ ...btn, opacity: 0.7 }} />
              </form>
            </>
          )}
        </div>
      ))}
    </main>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <p style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
      <span style={{ color: "var(--ink-muted)" }}>{label}:</span> {items.join(" · ")}
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
const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "0.6rem",
};
const lbl: React.CSSProperties = {
  display: "grid",
  gap: "0.25rem",
  fontSize: "0.85rem",
  color: "var(--ink-muted)",
};
const input: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
};
const btn: React.CSSProperties = {
  padding: "0.35rem 0.9rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
};
