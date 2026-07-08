import { briefs, modelDossiers } from "@deepblue/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import { isLlmConfigured } from "../../lib/llm";
import { fmtDate } from "../../lib/ui";
import { approveDossier, deleteDossier, generateDossier } from "./actions";

export const dynamic = "force-dynamic";

const SEVERITY_ES: Record<string, string> = {
  minor: "leve",
  moderate: "moderado",
  major: "grave",
  critical: "crítico",
};

export default async function DossiersPage() {
  const db = await getDb();
  const llmReady = isLlmConfigured();

  const rows = await db
    .select()
    .from(modelDossiers)
    .orderBy(modelDossiers.make, modelDossiers.model, desc(modelDossiers.version));

  const activeBriefs = await db.select().from(briefs).where(eq(briefs.status, "active"));
  const covered = new Set(rows.map((d) => `${d.make.toLowerCase()}|${d.model.toLowerCase()}`));
  const missing = new Map<string, { make: string; model: string; generation?: string }>();
  for (const brief of activeBriefs) {
    for (const vehicle of brief.criteria.vehicles) {
      const key = `${vehicle.make.toLowerCase()}|${vehicle.model.toLowerCase()}`;
      if (!covered.has(key) && !missing.has(key)) {
        missing.set(key, {
          make: vehicle.make,
          model: vehicle.model,
          generation: vehicle.generations?.[0],
        });
      }
    }
  }

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.2rem", marginBottom: "0.25rem" }}>Dossiers de fiabilidad</h1>
      <p style={{ color: "var(--ink-muted)", marginTop: 0, fontSize: "0.9rem" }}>
        Conocimiento con recibos: la IA investiga y redacta el borrador con fuentes; solo un
        dossier <strong>aprobado por ti</strong> puede alimentar veredictos.
      </p>
      {!llmReady && (
        <p style={{ ...notice }}>
          ANTHROPIC_API_KEY no configurada (apps/web/.env.local) — la generación con IA está
          desactivada; los dossiers existentes siguen funcionando.
        </p>
      )}

      {missing.size > 0 && (
        <>
          <h2 style={h2}>Modelos en búsqueda sin dossier</h2>
          {[...missing.values()].map((v) => (
            <div key={`${v.make}|${v.model}`} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
              <strong>
                {v.make} {v.model}
                {v.generation ? ` (${v.generation})` : ""}
              </strong>
              {llmReady ? (
                <form action={generateDossier}>
                  <input type="hidden" name="make" value={v.make} />
                  <input type="hidden" name="model" value={v.model} />
                  {v.generation && <input type="hidden" name="generation" value={v.generation} />}
                  <button type="submit" style={btn}>
                    Investigar y redactar borrador
                  </button>
                </form>
              ) : (
                <span style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>requiere API key</span>
              )}
            </div>
          ))}
          <p style={{ color: "var(--ink-muted)", fontSize: "0.8rem" }}>
            La investigación busca en la web y puede tardar unos minutos; la página se recarga al
            terminar.
          </p>
        </>
      )}

      <h2 style={h2}>Dossiers</h2>
      {rows.length === 0 && <p style={{ color: "var(--ink-muted)" }}>Todavía no hay ninguno.</p>}
      {rows.map((d) => {
        const c = d.content;
        const draft = d.reviewedAt === null;
        return (
          <div key={d.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
              <div>
                <strong>
                  {d.make} {d.model}
                </strong>{" "}
                <span style={{ color: "var(--ink-muted)" }}>
                  {c.generation ? `· ${c.generation} ` : ""}· v{d.version}
                </span>{" "}
                <span
                  style={{
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    color: draft ? "var(--grade-c)" : "var(--grade-a)",
                  }}
                >
                  {draft ? "BORRADOR — pendiente de tu revisión" : `en uso · aprobado ${fmtDate(d.reviewedAt!)}`}
                </span>
                <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem", color: "var(--ink-muted)" }}>
                  {c.knownIssues.length} problemas conocidos · {c.recalls.length} recalls ·{" "}
                  {c.sources.length} fuentes · creado {fmtDate(d.createdAt)}
                </p>
              </div>
              {draft && (
                <span style={{ display: "flex", gap: "0.4rem", alignItems: "start" }}>
                  <form action={approveDossier}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" style={{ ...btn, fontWeight: 600 }}>
                      Aprobar
                    </button>
                  </form>
                  <form action={deleteDossier}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" style={btn}>
                      Descartar
                    </button>
                  </form>
                </span>
              )}
            </div>

            <details style={{ marginTop: "0.6rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.87rem", color: "var(--ink-muted)" }}>
                Revisar contenido
              </summary>
              {c.knownIssues.map((issue) => (
                <div key={issue.title} style={{ ...card, margin: "0.6rem 0" }}>
                  <strong>{issue.title}</strong>{" "}
                  <span style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
                    · {SEVERITY_ES[issue.severity] ?? issue.severity}
                    {issue.typicalRepairCostEur
                      ? ` · ~${issue.typicalRepairCostEur.min.toLocaleString("es-ES")}–${issue.typicalRepairCostEur.max.toLocaleString("es-ES")} €`
                      : ""}
                  </span>
                  <p style={{ margin: "0.4rem 0", fontSize: "0.87rem" }}>{issue.description}</p>
                  <p style={pMuted}>
                    Aplica: {applicabilityText(issue.applicability)} · Se descarta con:{" "}
                    {issue.evidence.join("; ")}
                  </p>
                  <p style={pMuted}>
                    Fuentes:{" "}
                    {issue.sources.map((s, i) => (
                      <span key={s}>
                        {i > 0 && " · "}
                        <a href={s} target="_blank" rel="noreferrer">
                          {hostOf(s)}
                        </a>
                      </span>
                    ))}
                  </p>
                </div>
              ))}
              {c.recalls.length > 0 && (
                <p style={pMuted}>
                  Recalls: {c.recalls.map((r) => `${r.title}${r.year ? ` (${r.year})` : ""}`).join(" · ")}
                </p>
              )}
              {c.generalNotes.length > 0 && <p style={pMuted}>Notas: {c.generalNotes.join(" · ")}</p>}
            </details>
          </div>
        );
      })}

      <h2 style={h2}>Generar otro modelo</h2>
      <form action={generateDossier} style={{ ...card, display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "end" }}>
        <label style={lbl}>
          Marca *
          <input name="make" required placeholder="Toyota" style={inp} />
        </label>
        <label style={lbl}>
          Modelo *
          <input name="model" required placeholder="Corolla" style={inp} />
        </label>
        <label style={lbl}>
          Generación (opcional)
          <input name="generation" placeholder="XII (2019–)" style={inp} />
        </label>
        <button type="submit" style={btn} disabled={!llmReady}>
          Investigar y redactar borrador
        </button>
      </form>
    </main>
  );
}

function applicabilityText(a: {
  kmMin?: number;
  kmMax?: number;
  yearMin?: number;
  yearMax?: number;
  fuel?: string;
  gearbox?: string;
  powerCvMin?: number;
  powerCvMax?: number;
}): string {
  const parts = [
    a.kmMin !== undefined ? `desde ~${a.kmMin.toLocaleString("es-ES")} km` : undefined,
    a.kmMax !== undefined ? `hasta ${a.kmMax.toLocaleString("es-ES")} km` : undefined,
    a.yearMin !== undefined ? `desde ${a.yearMin}` : undefined,
    a.yearMax !== undefined ? `hasta ${a.yearMax}` : undefined,
    a.fuel === "diesel" ? "diésel" : a.fuel === "gasoline" ? "gasolina" : undefined,
    a.gearbox === "automatic" ? "automático" : a.gearbox === "manual" ? "manual" : undefined,
    a.powerCvMin !== undefined || a.powerCvMax !== undefined
      ? `${a.powerCvMin ?? "?"}–${a.powerCvMax ?? "?"} CV`
      : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "todas las unidades";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const card: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.9rem 1rem",
  margin: "0.6rem 0",
};
const h2: React.CSSProperties = { fontSize: "1rem", margin: "1.8rem 0 0.5rem" };
const notice: React.CSSProperties = {
  ...card,
  fontSize: "0.85rem",
  color: "var(--grade-c)",
};
const pMuted: React.CSSProperties = {
  margin: "0.35rem 0",
  fontSize: "0.82rem",
  color: "var(--ink-muted)",
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
