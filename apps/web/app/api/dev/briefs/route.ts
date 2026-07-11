import { briefs } from "@deepblue/db";
import { getDb } from "../../../../lib/db";

/** Dev-only: briefs with their criteria, to see what the agent is hunting. */
export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const db = await getDb();
  const rows = await db.select().from(briefs);
  return Response.json(
    rows.map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      criteria: b.criteria,
      hardLimits: b.hardLimits,
      createdAt: b.createdAt,
    })),
  );
}
