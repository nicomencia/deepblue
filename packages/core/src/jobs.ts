/**
 * Job contracts between the Core (cloud) and Runners (residential IP).
 * The Runner is hands, never brain: payloads carry exact instructions
 * (e.g. the literal message text), never decisions to make.
 */

import { z } from "zod";

export const JOB_TYPES = [
  "search_sweep",
  "fetch_listing",
  "check_listing",
  "send_message",
  "fetch_replies",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "leased", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const platformSchema = z.enum(["wallapop", "autoscout24"]);

export const searchSweepPayload = z.object({
  type: z.literal("search_sweep"),
  platform: platformSchema,
  briefId: z.string(),
  query: z.object({
    keywords: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    priceMaxEur: z.number().optional(),
    priceMinEur: z.number().optional(),
    yearMin: z.number().optional(),
    kmMax: z.number().optional(),
    fuel: z.enum(["gasoline", "diesel", "hybrid", "electric"]).optional(),
    location: z
      .object({ lat: z.number(), lon: z.number(), radiusKm: z.number() })
      .optional(),
  }),
});

export const fetchListingPayload = z.object({
  type: z.literal("fetch_listing"),
  platform: platformSchema,
  /** May be a provisional web id from a pasted URL; the adapter resolves it. */
  platformListingId: z.string(),
  url: z.string().optional(),
  /**
   * Present when the user adopted this ad by hand: on ingest, the Core turns
   * it into a manual lead (matching or creating its brief) instead of just
   * refreshing listing detail.
   */
  adopt: z
    .object({
      maxPriceEur: z.number().optional(),
      briefId: z.string().optional(),
    })
    .optional(),
});

/** Liveness probe: is this specific listing still on sale, reserved, or gone? */
export const checkListingPayload = z.object({
  type: z.literal("check_listing"),
  platform: platformSchema,
  platformListingId: z.string(),
  url: z.string().optional(),
});

export const LISTING_CHECK_STATUSES = ["active", "reserved", "gone"] as const;
export type ListingCheckStatus = (typeof LISTING_CHECK_STATUSES)[number];

/** What the Runner reports back from a check_listing probe (a trust boundary). */
export const listingCheckResultSchema = z.object({
  platform: platformSchema,
  platformListingId: z.string(),
  status: z.enum(LISTING_CHECK_STATUSES),
  /** Current asking price when alive — the probe sees the ad, so price drops surface. */
  priceEur: z.number().positive().optional(),
});
export type ListingCheckResult = z.infer<typeof listingCheckResultSchema>;

export const sendMessagePayload = z.object({
  type: z.literal("send_message"),
  platform: platformSchema,
  platformListingId: z.string(),
  /** Listing web URL — the browser opens the chat from the ad page. */
  url: z.string().optional(),
  platformConversationId: z.string().optional(),
  /** The exact text to send — composed and approved in the Core. */
  body: z.string(),
  /** Core-side message row this send belongs to. */
  messageId: z.string(),
});

/** What the Runner reports back from a send_message job (a trust boundary). */
export const sendResultSchema = z.object({
  externalId: z.string().optional(),
  sentAt: z.string(),
});

export const fetchRepliesPayload = z.object({
  type: z.literal("fetch_replies"),
  platform: platformSchema,
  platformListingId: z.string(),
  platformConversationId: z.string().optional(),
  sinceExternalId: z.string().optional(),
});

/** What the Runner reports back from a fetch_replies job (a trust boundary). */
export const inboundMessageSchema = z.object({
  conversation: z.object({
    platform: platformSchema,
    platformListingId: z.string(),
    platformConversationId: z.string().optional(),
  }),
  /**
   * Stable identity for dedup. Wallapop's chat DOM carries no message ids,
   * so the adapter derives one (hash of direction+text+HH:MM); the Core
   * skips externalIds it has already stored for the lead.
   */
  externalId: z.string(),
  body: z.string(),
  receivedAt: z.string(),
});

export const jobPayloadSchema = z.discriminatedUnion("type", [
  searchSweepPayload,
  fetchListingPayload,
  checkListingPayload,
  sendMessagePayload,
  fetchRepliesPayload,
]);
export type JobPayload = z.infer<typeof jobPayloadSchema>;

export interface LeasedJob {
  id: string;
  payload: JobPayload;
  attempts: number;
}
