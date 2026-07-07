import { normalizedListingSchema } from "@deepblue/core";
import { jobs } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../../lib/db";
import { ingestListingDetail, ingestSearchResults } from "../../../../../../lib/ingest";
import { isAuthorizedRunner } from "../../../../../../lib/runner-auth";

const reportSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAuthorizedRunner(req)) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const db = await getDb();

  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return new Response("job not found", { status: 404 });
  if (job.status !== "leased") return new Response("job not leased", { status: 409 });

  const report = reportSchema.parse(await req.json());

  // Trust boundary: validate everything the runner reports before ingesting.
  let ingestStats: unknown;
  if (report.status === "succeeded" && job.payload.type === "search_sweep") {
    const items = z.array(normalizedListingSchema).parse(report.result ?? []);
    ingestStats = await ingestSearchResults(db, job.payload.briefId, items);
  } else if (report.status === "succeeded" && job.payload.type === "fetch_listing") {
    const item = normalizedListingSchema.parse(report.result);
    ingestStats = await ingestListingDetail(db, item);
  }

  await db
    .update(jobs)
    .set({
      status: report.status,
      result: ingestStats ?? report.result ?? null,
      lastError: report.error,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id));

  return Response.json({ ok: true, stats: ingestStats ?? null });
}
