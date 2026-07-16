import {
  inboundMessageSchema,
  listingCheckResultSchema,
  normalizedListingSchema,
  sendResultSchema,
} from "@deepblue/core";
import { events, jobs, users } from "@deepblue/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { completeAdoption } from "../../../../../../lib/adopt";
import { getDb } from "../../../../../../lib/db";
import { sendEmail } from "../../../../../../lib/email";
import { ingestListingDetail, ingestSearchResults } from "../../../../../../lib/ingest";
import { applyInboundMessages, applySendResult } from "../../../../../../lib/outreach";
import { applyListingCheck } from "../../../../../../lib/reaper";
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
    // Adoption intent rides the same job type; the Core decides what it means.
    ingestStats = job.payload.adopt
      ? await completeAdoption(db, job.userId, item, job.payload.adopt)
      : await ingestListingDetail(db, item);
  } else if (report.status === "succeeded" && job.payload.type === "check_listing") {
    const check = listingCheckResultSchema.parse(report.result);
    ingestStats = await applyListingCheck(db, check);
  } else if (job.payload.type === "send_message") {
    // Success and failure both land on the message row — a failed send must
    // surface on the lead page, not die silently in the jobs table.
    if (report.status === "succeeded") {
      const sent = sendResultSchema.parse(report.result);
      await applySendResult(db, job.payload.messageId, { ok: true, ...sent });
    } else {
      await applySendResult(db, job.payload.messageId, {
        ok: false,
        error: report.error ?? "unknown send failure",
      });
    }
  } else if (report.status === "succeeded" && job.payload.type === "fetch_replies") {
    const inbound = z.array(inboundMessageSchema).parse(report.result ?? []);
    ingestStats = await applyInboundMessages(
      db,
      job.payload.platform,
      job.payload.platformListingId,
      inbound,
    );
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

  // A tripped circuit breaker is account-safety news: audit it and tell the
  // user immediately. At most one report carries this error per cooldown
  // (the runner stops leasing after it), so this cannot spam.
  if (report.status === "failed" && report.error?.startsWith("platform_blocked")) {
    await db.insert(events).values({
      userId: job.userId,
      type: "platform_blocked",
      payload: { jobId: job.id, jobType: job.payload.type, error: report.error },
    });
    const [owner] = await db.select().from(users).where(eq(users.id, job.userId)).limit(1);
    if (owner) {
      await sendEmail({
        to: owner.email,
        subject: "deepblue · Wallapop ha bloqueado una petición — runner en pausa",
        text:
          `El runner ha recibido un bloqueo (403/429) y se ha pausado solo:\n\n${report.error}\n\n` +
          "No hace falta hacer nada: reanudará solo tras el enfriamiento. Si esto se repite a " +
          "menudo, conviene bajar la frecuencia de sweeps (SWEEP_INTERVAL_MINUTES).",
      });
    }
  }

  return Response.json({ ok: true, stats: ingestStats ?? null });
}
