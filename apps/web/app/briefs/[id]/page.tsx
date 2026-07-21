import { briefs } from "@deepblue/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db";
import { updateBrief } from "../actions";
import { BriefForm } from "../brief-form";

export const dynamic = "force-dynamic";

export default async function EditBriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = await getDb();
  const [brief] = await db.select().from(briefs).where(eq(briefs.id, id)).limit(1);
  if (!brief) notFound();

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.2rem", marginBottom: "0.25rem" }}>Editar búsqueda</h1>
      <p style={{ color: "var(--ink-muted)", marginTop: 0, fontSize: "0.9rem" }}>
        Al guardar se re-evalúan los leads de esta búsqueda: límites más
        estrictos matan ahora (un lead muerto no resucita); límites más amplios
        aparecen con el siguiente barrido, que se lanza automáticamente.
      </p>
      <BriefForm
        action={updateBrief}
        brief={brief}
        submitLabel="Guardar cambios"
        pendingLabel="⏳ Guardando y re-evaluando…"
      />
      <p style={{ fontSize: "0.85rem" }}>
        <Link href="/briefs">← Volver a búsquedas</Link>
      </p>
    </main>
  );
}
