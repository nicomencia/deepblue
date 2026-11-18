import { ECO_LABELS, normalizeImageUrl } from "@deepblue/core";
import { briefs, discoveries } from "@deepblue/db";
import { desc, ne } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../../lib/db";
import { briefNameForRecommendation } from "../../lib/discovery";
import {
  BODY_OPTIONS,
  KM_BANDS,
  MAX_TOP_PRIORITIES,
  PRIORITY_OPTIONS,
  SEAT_OPTIONS,
} from "../../lib/discovery-form";
import { SEARCH_CENTERS } from "../../lib/search-area";
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

  // ONLY the recommendations still missing a photo.
  //
  // Photos are resolved once, at save time, and stored in the report — and the
  // card below prefers that stored URL. Asking again here for a report that
  // already has them bought nothing and cost everything: every navigation to
  // this page ran the full Wikimedia ladder for each recommendation and threw
  // the answers away, so a first load took 20-39 s and only felt fast once the
  // in-memory cache was warm (measured 2026-07-28). Legacy reports stored
  // before save-time resolution still get their free fallback.
  const recPhotos = await resolveModelPhotos(
    db,
    sessions.flatMap((s) =>
      (s.report?.recommendations ?? [])
        .filter((rec) => !normalizeImageUrl(rec.imageUrl))
        .map((rec) => ({
          make: rec.make,
          model: rec.model,
          generation: rec.generation,
          // Era gate: the recommendation names the generation being proposed;
          // a current-generation stock photo would misrepresent it.
          yearMin: rec.yearMin,
          yearMax: rec.yearMax,
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

      {/* Intake form. Free text where the buyer explains themselves; dropdowns
          and checkboxes for the few facts the advisor cannot do without. */}
      <ActionForm action={createDiscovery} style={{ ...card, display: "grid", gap: "0.9rem" }}>
        <div>
          <strong>Nuevo perfil de búsqueda</strong>
          <p style={{ ...hint, margin: "0.2rem 0 0" }}>
            Cuanto más cuentes con tus palabras, mejor afina. Lo marcado con * es obligatorio.
          </p>
        </div>

        <div style={grid2}>
          <label style={lbl}>
            Presupuesto (€) *
            <input name="budgetEur" required inputMode="numeric" placeholder="20.000" style={input} />
          </label>
          <label style={lbl}>
            Kilómetros al año *
            <select name="kmBand" required defaultValue="" style={input}>
              <option value="" disabled>
                Elige…
              </option>
              {KM_BANDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label style={lbl}>
          ¿Para qué lo quieres? *
          <textarea
            name="usage"
            required
            rows={4}
            placeholder="Uso diario, autopista o ciudad, niños, montaña, viajes largos, aparcar en la calle… Cuéntalo como se lo contarías a un amigo que sabe de coches."
            style={input}
          />
        </label>

        <div style={grid3}>
          <label style={lbl}>
            Plazas *
            <select name="seats" required defaultValue="" style={input}>
              <option value="" disabled>
                Elige…
              </option>
              {SEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label style={lbl}>
            Cambio
            <select name="gearbox" defaultValue="any" style={input}>
              <option value="any">Me da igual</option>
              <option value="manual">Manual</option>
              <option value="automatic">Automático</option>
            </select>
          </label>
          <label style={lbl}>
            Tracción
            <select name="drivetrain" defaultValue="any" style={input}>
              <option value="any">Me da igual</option>
              <option value="4x4">Necesito 4x4</option>
            </select>
          </label>
        </div>

        <fieldset style={fieldset}>
          <legend style={legend}>Combustible — sin marcar, me da igual</legend>
          <div style={chips}>
            {(["gasoline", "diesel", "hybrid", "electric"] as const).map((f) => (
              <label key={f} style={chip}>
                <input type="checkbox" name="fuel" value={f} />{" "}
                {{ gasoline: "Gasolina", diesel: "Diésel", hybrid: "Híbrido", electric: "Eléctrico" }[f]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>Carrocerías que te valen — sin marcar, cualquiera</legend>
          <div style={chips}>
            {BODY_OPTIONS.map((b) => (
              <label key={b.value} style={chip}>
                <input type="checkbox" name="body" value={b.value} /> {b.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>
            Lo que más te importa * — marca de 1 a {MAX_TOP_PRIORITIES}: son las que deciden
          </legend>
          <div style={chips}>
            {PRIORITY_OPTIONS.map((p) => (
              <label key={p} style={chip}>
                <input type="checkbox" name="topPriority" value={p} /> {p.charAt(0).toUpperCase() + p.slice(1)}
              </label>
            ))}
          </div>
          <label style={{ ...lbl, marginTop: "0.5rem" }}>
            ¿Algo más que te importe? (separa con comas)
            <input name="otherPriorities" placeholder="buena insonorización, etiqueta ECO, que sea bonito…" style={input} />
          </label>
        </fieldset>

        <div style={grid2}>
          <label style={lbl}>
            Imprescindible (separa con comas)
            <input name="mustHaves" placeholder="Isofix, aire acondicionado, bola de remolque…" style={input} />
          </label>
          <label style={lbl}>
            No lo quiero (separa con comas)
            <input name="dealBreakers" placeholder="nada de SUV, cambio CVT, coches de más de 15 años…" style={input} />
          </label>
        </div>

        <label style={lbl}>
          Coches que has tenido o probado: qué te gustó y qué no
          <textarea
            name="notes"
            rows={3}
            placeholder="Tuve un Golf y me encantó cómo iba; probé un SUV y me pareció un camión en curvas…"
            style={input}
          />
        </label>

        {/* Everything else is optional and folded away: limits that are real
            filters (inherited by every búsqueda created from this profile) and
            hunt settings that don't change the recommendation. */}
        <details style={fieldset}>
          <summary style={{ ...legend, cursor: "pointer" }}>Más filtros (opcional)</summary>
          <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.6rem" }}>
            <div style={grid3}>
              <label style={lbl}>
                Año mínimo
                <input name="yearMin" inputMode="numeric" placeholder="2015" style={input} />
              </label>
              <label style={lbl}>
                Año máximo
                <input name="yearMax" inputMode="numeric" placeholder="2022" style={input} />
              </label>
              <label style={lbl}>
                Km máximos
                <input name="kmMax" inputMode="numeric" placeholder="150.000" style={input} />
              </label>
            </div>
            <div style={grid3}>
              <label style={lbl}>
                Etiqueta DGT mínima
                <select name="ecoLabelMin" defaultValue="" style={input}>
                  <option value="">Me da igual</option>
                  {ECO_LABELS.map((e) => (
                    <option key={e} value={e}>
                      {e === "0" ? "0 (cero emisiones)" : e}
                    </option>
                  ))}
                </select>
              </label>
              <label style={lbl}>
                Tolerancia al riesgo
                <select name="riskTolerance" defaultValue="medium" style={input}>
                  <option value="low">Baja — prima la fiabilidad</option>
                  <option value="medium">Media</option>
                  <option value="high">Alta — prima el precio</option>
                </select>
              </label>
              <label style={lbl}>
                Tipo de vendedor
                <select name="sellerPreference" defaultValue="prefer_private" style={input}>
                  <option value="prefer_private">Prefiero particulares</option>
                  <option value="any">Me da igual</option>
                </select>
              </label>
            </div>
            <div style={grid2}>
              <label style={lbl}>
                Buscar cerca de
                <select name="center" defaultValue="" style={input}>
                  <option value="">Toda España</option>
                  {SEARCH_CENTERS.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={lbl}>
                Radio (km) — solo si eliges ciudad
                <input name="radiusKm" inputMode="numeric" placeholder="150" style={input} />
              </label>
            </div>
            <div style={{ ...chips, fontSize: "0.85rem" }}>
              <label>
                <input type="checkbox" name="noRhd" value="1" /> Descartar volante a la derecha
              </label>
              <label>
                <input type="checkbox" name="requireSpanishPlates" value="1" /> Solo matriculados en España
              </label>
            </div>
          </div>
        </details>

        <div>
          <SubmitButton label="Crear perfil" pendingLabel="⏳ Creando…" style={btn} />
        </div>
      </ActionForm>

      {/* Sessions */}
      {sessions.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>
              {fmtEur(s.profile.budgetEur)} · {s.profile.usage.length > 90 ? `${s.profile.usage.slice(0, 90)}…` : s.profile.usage}
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
                      {/* Drivetrain sits in the title because it is part of
                          the identity of what is being recommended, not a
                          detail: the 4x2 and the 4x4 are thousands apart. */}
                      {rec.drivetrain ? ` ${rec.drivetrain}` : ""}
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
                  {/* Why it fits leads: it is the only section that answers
                      the question this page exists for — which of these do I
                      pick. The other three are handoffs to the búsqueda and
                      the dossier, and reading them first buries the choice. */}
                  <List label="Por qué encaja" items={rec.whyFits} />
                  <List label="Buscar" items={rec.versions} />
                  <List label="Evitar" items={rec.avoidVersions} />
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
const grid3: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: "0.6rem",
};
const fieldset: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.6rem 0.8rem",
  margin: 0,
};
const legend: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--ink-muted)",
  padding: "0 0.3rem",
};
const chips: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem 0.6rem",
};
const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.25rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: 999,
  fontSize: "0.85rem",
  cursor: "pointer",
};
const hint: React.CSSProperties = { fontSize: "0.8rem", color: "var(--ink-muted)" };
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
