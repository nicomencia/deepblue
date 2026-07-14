/**
 * Tenancy rule: every user-owned table carries userId from day one.
 * Shared corpus tables (listings, model_dossiers) are deliberately global —
 * marketplace data and reliability knowledge are the same for every user.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AutonomyMode,
  BriefCriteria,
  ConfidenceVerdict,
  DiscoveryProfile,
  DiscoveryReport,
  HardLimits,
  IssueFinding,
  JobPayload,
  JobStatus,
  LeadState,
  LlmEnrichment,
  MessageChannel,
  MessageDirection,
  MessageStatus,
  ModelDossier,
  Platform,
} from "@deepblue/core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    status: text("status").$type<"active" | "paused" | "fulfilled" | "archived">()
      .notNull()
      .default("active"),
    criteria: jsonb("criteria").$type<BriefCriteria>().notNull(),
    hardLimits: jsonb("hard_limits").$type<HardLimits>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("briefs_user_idx").on(t.userId)],
);

/** Global marketplace corpus — also the raw material for price benchmarking. */
export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").$type<Platform>().notNull(),
    platformListingId: text("platform_listing_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priceEur: integer("price_eur"),
    /** Real cash price parsed from the ad text (financing-conditional headlines). */
    cashPriceEur: integer("cash_price_eur"),
    make: text("make"),
    model: text("model"),
    version: text("version"),
    year: integer("year"),
    km: integer("km"),
    fuel: text("fuel"),
    gearbox: text("gearbox"),
    powerCv: integer("power_cv"),
    ecoLabel: text("eco_label"),
    sellerType: text("seller_type").$type<"private" | "dealer" | "unknown">(),
    sellerName: text("seller_name"),
    sellerRating: real("seller_rating"),
    sellerReviewCount: integer("seller_review_count"),
    sellerSoldCount: integer("seller_sold_count"),
    /** Set when the detail-enrichment pass (fetch_listing) has run. */
    detailFetchedAt: timestamp("detail_fetched_at", { withTimezone: true }),
    locationText: text("location_text"),
    /** Market scoping: prices are only comparable within one country. */
    countryCode: text("country_code"),
    lat: real("lat"),
    lon: real("lon"),
    raw: jsonb("raw"),
    /** Physical-car identity across accounts (dealer internal REF), for dedup. */
    dedupKey: text("dedup_key"),
    active: boolean("active").notNull().default(true),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listings_platform_id_idx").on(t.platform, t.platformListingId),
    index("listings_dedup_key_idx").on(t.dedupKey),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    briefId: uuid("brief_id").notNull().references(() => briefs.id),
    listingId: uuid("listing_id").notNull().references(() => listings.id),
    state: text("state").$type<LeadState>().notNull().default("discovered"),
    /** "manual" = adopted by the user from a pasted URL; survives hard filters. */
    origin: text("origin").$type<"sweep" | "manual">().notNull().default("sweep"),
    autonomyMode: text("autonomy_mode").$type<AutonomyMode>()
      .notNull()
      .default("draft_only"),
    verdict: jsonb("verdict").$type<ConfidenceVerdict>(),
    /** LLM read of the ad, stored raw so re-evaluations can re-merge it. */
    enrichment: jsonb("enrichment").$type<LlmEnrichment>(),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    /** Human-verified issue outcomes (seller evidence); reapplied on every re-evaluation. */
    issueFindings: jsonb("issue_findings").$type<IssueFinding[]>(),
    /** Set when an instant alert email fired — the digest labels these as recap. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    deadReason: text("dead_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("leads_brief_listing_idx").on(t.briefId, t.listingId),
    index("leads_user_state_idx").on(t.userId, t.state),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    leadId: uuid("lead_id").notNull().references(() => leads.id),
    direction: text("direction").$type<MessageDirection>().notNull(),
    channel: text("channel").$type<MessageChannel>().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    body: text("body").notNull(),
    /** Platform-native message id, for dedup of inbound fetches. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("messages_lead_idx").on(t.leadId)],
);

/** Pending human decisions, each addressable by a signed one-click token in email. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    leadId: uuid("lead_id").notNull().references(() => leads.id),
    kind: text("kind").$type<"send_message" | "accept_price" | "book_visit">().notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").$type<"pending" | "approved" | "rejected" | "expired">()
      .notNull()
      .default("pending"),
    actionToken: text("action_token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("approvals_user_status_idx").on(t.userId, t.status)],
);

/** Append-only audit log of everything the agent did and why. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    leadId: uuid("lead_id").references(() => leads.id),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_lead_idx").on(t.leadId)],
);

/** The Core↔Runner queue. Deliberately boring: a table, leases, retries. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<JobPayload>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    leasedBy: uuid("leased_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    result: jsonb("result"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_status_idx").on(t.status, t.createdAt)],
);

/** Registered runners; each authenticates with a token bound to one user. */
export const runners = pgTable("runners", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Discovery sessions: the "which car should I even hunt?" advisor. The intake
 * profile is filled by the user; the report arrives via the LLM lane (API key)
 * or a Claude Code session import, and its recommendations become briefs.
 */
export const discoveries = pgTable(
  "discoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    profile: jsonb("profile").$type<DiscoveryProfile>().notNull(),
    report: jsonb("report").$type<DiscoveryReport>(),
    /** Which lane produced the report: model id or "claude-code-session". */
    reportSource: text("report_source"),
    status: text("status").$type<"pending" | "ready" | "archived">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reportAt: timestamp("report_at", { withTimezone: true }),
  },
  (t) => [index("discoveries_user_idx").on(t.userId)],
);

/** Global reliability knowledge base — source-cited, versioned, live on creation. */
export const modelDossiers = pgTable(
  "model_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    generation: text("generation"),
    engineCode: text("engine_code"),
    version: integer("version").notNull().default(1),
    content: jsonb("content").$type<ModelDossier>().notNull(),
    /** When the dossier went live (set at creation since auto-approval, 2026-07-14). */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Review is opt-out: a disabled dossier stops driving claims immediately. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dossiers_identity_idx").on(t.make, t.model, t.generation, t.engineCode, t.version),
  ],
);
