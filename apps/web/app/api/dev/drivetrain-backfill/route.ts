import { normalizeDrivetrain } from "@deepblue/core";
import { listings } from "@deepblue/db";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../lib/db";

/**
 * Dev-only: read the drivetrain out of the ad text of listings stored before
 * the column existed.
 *
 * Free (no LLM, no network) and idempotent — only rows whose drivetrain is
 * still NULL are touched. It matters because the benchmark now prices a 4x4
 * against 4x4s: with an empty column the corpus has nothing to separate on,
 * so every comparable stays neutral and the mixing this fixes continues until
 * the whole corpus has been re-swept.
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });

  const db = await getDb();
  const rows = await db
    .select({
      id: listings.id,
      version: listings.version,
      title: listings.title,
      description: listings.description,
    })
    .from(listings)
    .where(isNull(listings.drivetrain));

  const counts = { "4x4": 0, "4x2": 0, unknown: 0 };
  for (const row of rows) {
    const drivetrain = normalizeDrivetrain(
      row.version ?? undefined,
      row.title ?? undefined,
      row.description ?? undefined,
    );
    if (!drivetrain) {
      counts.unknown += 1;
      continue;
    }
    counts[drivetrain] += 1;
    await db.update(listings).set({ drivetrain }).where(eq(listings.id, row.id));
  }

  return Response.json({ ok: true, scanned: rows.length, ...counts });
}
