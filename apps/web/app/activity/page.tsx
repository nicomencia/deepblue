import { events, jobs } from "@deepblue/db";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "../../lib/db";
import { fmtDate } from "../../lib/ui";

export const dynamic = "force-dynamic";

const JOB_STATUS_COLOR: Record<string, string> = {
  queued: "var(--grade-c)",
  leased: "var(--grade-b)",
  succeeded: "var(--grade-a)",
  failed: "var(--grade-e)",
};

/** One glanceable line per job payload, without dumping raw JSON. */
function jobGist(payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (typeof p.keywords === "string") return p.keywords;
  const q = p.query as Record<string, unknown> | undefined;
  if (q && typeof q.keywords === "string") return q.keywords;
  if (typeof p.url === "string") return p.url.replace(/^https?:\/\/(es\.|www\.)?/, "").slice(0, 60);
  if (typeof p.platformListingId === "string") return `#${p.platformListingId}`;
  return JSON.stringify(p).slice(0, 60);
}

function eventGist(payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (typeof p.title === "string") {
    const extra = [p.outcome, p.overall && `[${p.overall}]`].filter(Boolean).join(" ");
    return `${extra ? `${extra} · ` : ""}${String(p.title).slice(0, 60)}`;
  }
  return JSON.stringify(p).slice(0, 90);
}

export default async function Activity() {
  const db = await getDb();
  const [jobRows, eventRows] = await Promise.all([
    db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(30),
    db.select().from(events).orderBy(desc(events.createdAt)).limit(40),
  ]);

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Cola de trabajos</h2>
      <p style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
        Los últimos 30 trabajos del runner, más reciente primero.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
              <th style={th}>Estado</th>
              <th style={th}>Tipo</th>
              <th style={th}>Detalle</th>
              <th style={th}>Intentos</th>
              <th style={th}>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {jobRows.map((j) => (
              <tr key={j.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ ...td, fontWeight: 700, color: JOB_STATUS_COLOR[j.status] }}>
                  {j.status}
                </td>
                <td style={td}>{j.type}</td>
                <td style={{ ...td, color: "var(--ink-muted)" }}>
                  {jobGist(j.payload)}
                  {j.lastError && (
                    <div style={{ color: "var(--grade-e)", fontSize: "0.8rem" }}>
                      {j.lastError.slice(0, 120)}
                    </div>
                  )}
                </td>
                <td style={td}>{j.attempts}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDate(j.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.1rem" }}>Eventos</h2>
      <p style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
        Registro de auditoría: todo lo que el agente hizo y por qué (últimos 40).
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
              <th style={th}>Cuándo</th>
              <th style={th}>Tipo</th>
              <th style={th}>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {eventRows.map((e) => (
              <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDate(e.createdAt)}</td>
                <td style={td}>{e.type}</td>
                <td style={{ ...td, color: "var(--ink-muted)" }}>
                  {e.leadId ? (
                    <Link href={`/leads/${e.leadId}`} style={{ textDecoration: "none" }}>
                      {eventGist(e.payload)}
                    </Link>
                  ) : (
                    eventGist(e.payload)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 0.75rem" };
const td: React.CSSProperties = { padding: "0.5rem 0.75rem" };
