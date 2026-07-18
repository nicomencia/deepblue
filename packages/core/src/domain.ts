/**
 * Domain types for deepblue. Platform-agnostic and vendor-agnostic:
 * this package must never import a cloud SDK or a marketplace client.
 */

import { z } from "zod";

export const PLATFORMS = ["wallapop", "autoscout24"] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Platforms currently in the loop: swept, evaluated into leads, and kept
 * fresh. AutoScout24 is paused for now (its adapter, schema and data stay
 * intact — this is a one-line re-enable). Leads on any non-active platform
 * are retired to dead(platform_paused) by the maintenance pass, and price
 * benchmarks only draw comparables from active platforms so a stalled
 * platform's rotting prices never skew scoring.
 */
export const ACTIVE_PLATFORMS: readonly Platform[] = ["wallapop"];

export function isPlatformActive(platform: Platform): boolean {
  return ACTIVE_PLATFORMS.includes(platform);
}

// ---------------------------------------------------------------------------
// Lead lifecycle
// ---------------------------------------------------------------------------

export const LEAD_STATES = [
  "discovered",
  "evaluated",
  "shortlisted",
  "contacted",
  "negotiating",
  "agreement",
  "visit_proposed",
  "handed_off",
  "dead",
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/**
 * Legal transitions of the lead state machine. Everything may die;
 * nothing may skip forward past an unvisited stage.
 */
const LEAD_TRANSITIONS: Record<LeadState, readonly LeadState[]> = {
  discovered: ["evaluated"],
  evaluated: ["shortlisted", "dead"],
  shortlisted: ["contacted", "dead"],
  contacted: ["negotiating", "dead"],
  negotiating: ["agreement", "dead"],
  agreement: ["visit_proposed", "dead"],
  visit_proposed: ["handed_off", "negotiating", "dead"],
  handed_off: [],
  dead: [],
};

export function canTransition(from: LeadState, to: LeadState): boolean {
  return LEAD_TRANSITIONS[from].includes(to);
}

/** Per-conversation autonomy dial. Everything starts in draft_only. */
export const AUTONOMY_MODES = ["draft_only", "delegated", "paused"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

// ---------------------------------------------------------------------------
// Brief — what the user wants
// ---------------------------------------------------------------------------

/**
 * Hard limits are enforced by orchestration code, never merely by prompt.
 * The agent physically cannot offer above maxPriceEur.
 */
export interface HardLimits {
  maxPriceEur: number;
  nonNegotiables: string[];
  /** RHD at no price: confirmed right-hand drive is dead on arrival. */
  noRhd?: boolean;
  /** Some imports can't be homologated at all: foreign plates are dead on arrival. */
  requireSpanishPlates?: boolean;
}

export interface BriefCriteria {
  /** e.g. [{ make: "Volkswagen", model: "Golf", generations: ["VII"] }] */
  vehicles: Array<{
    make: string;
    model: string;
    generations?: string[];
    engines?: string[];
  }>;
  yearMin?: number;
  yearMax?: number;
  kmMax?: number;
  fuel?: Array<"gasoline" | "diesel" | "hybrid" | "electric">;
  gearbox?: Array<"manual" | "automatic">;
  /** Target price the user would be happy with (asking prices above maxPrice are still scouted for negotiation headroom). */
  targetPriceEur?: number;
  /** Search center + radius, e.g. { lat, lon, radiusKm } */
  location?: { lat: number; lon: number; radiusKm: number };
  /**
   * How much unit risk the user accepts. Low budgets often mean gambling
   * knowingly on unverified issues — that's a valid strategy, and the agent
   * weighs price vs theoretical risk accordingly. Default: "medium".
   */
  riskTolerance?: RiskTolerance;
  /**
   * "prefer_private" penalizes high-volume compraventa chains in the seller
   * factor: private sellers and small dealers score better. Default: "any".
   */
  sellerPreference?: "any" | "prefer_private";
  /** Free-form conditions the agent must honor ("no repainted panels", "one owner preferred") */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/**
 * A listing normalized from any platform into one shape. Defined as a zod
 * schema because it crosses the Runner→Core trust boundary: the Core always
 * validates what Runners report before it touches the database.
 */
export const normalizedListingSchema = z.object({
  platform: z.enum(PLATFORMS),
  platformListingId: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priceEur: z.number().optional(),
  /**
   * Real price without financing strings attached, parsed from the ad text
   * (compraventa chains headline the financing-conditional price). When
   * present, evaluation and benchmarks use this, never the headline.
   */
  cashPriceEur: z.number().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  version: z.string().optional(),
  year: z.number().optional(),
  km: z.number().optional(),
  fuel: z.string().optional(),
  gearbox: z.string().optional(),
  powerCv: z.number().optional(),
  /** DGT environmental badge (0, ECO, C, B...) — matters for Spanish city access. */
  ecoLabel: z.string().optional(),
  /** First ad photo (platform CDN URL): email thumbnails and dashboard cards. */
  imageUrl: z.string().optional(),
  /**
   * Verified import facts. undefined = unknown; set true by explicit ad text
   * at ingest, and either way by the user from the lead page (photos tell
   * what the text hides). An explicit value always beats text inference.
   */
  rhd: z.boolean().optional(),
  foreignPlates: z.boolean().optional(),
  /** ISO country of the listing's market. Prices are only comparable within one market. */
  countryCode: z.string().optional(),
  sellerType: z.enum(["private", "dealer", "unknown"]).optional(),
  sellerName: z.string().optional(),
  /** Platform profile reputation, filled by detail enrichment. */
  sellerRating: z.number().optional(),
  sellerReviewCount: z.number().optional(),
  sellerSoldCount: z.number().optional(),
  locationText: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  /** Untouched platform payload, kept for reprocessing when normalization improves. */
  raw: z.unknown(),
});
export type NormalizedListing = z.infer<typeof normalizedListingSchema>;

// ---------------------------------------------------------------------------
// Confidence verdict — honest precision (see PROJECT.md, Reliability pillar)
// ---------------------------------------------------------------------------

export const CONFIDENCE_GRADES = ["A", "B", "C", "D", "E"] as const;
export type ConfidenceGrade = (typeof CONFIDENCE_GRADES)[number];

/** Is `grade` at least as good as `threshold`? (A-best ordinal scale.) */
export function gradeAtMost(grade: ConfidenceGrade, threshold: ConfidenceGrade): boolean {
  return CONFIDENCE_GRADES.indexOf(grade) <= CONFIDENCE_GRADES.indexOf(threshold);
}

export type RiskTolerance = "low" | "medium" | "high";

/** Every factor separates what is known from what is assumed from what is unverified. */
export interface VerdictFactor {
  grade: ConfidenceGrade;
  /** 0–100 subscore feeding the weighted overall (grade is its banded display). */
  score: number;
  known: string[];
  assumed: string[];
  unverified: string[];
}

/**
 * A dossier issue projected onto one specific unit. Theory never kills a
 * lead: unconfirmed issues are verification work, not verdicts. Seller
 * answers (Phase 2) move status to confirmed/ruled_out; the user makes
 * the final call with the exposure numbers in front of them.
 */
export interface IssueAssessment {
  title: string;
  severity: "minor" | "moderate" | "major" | "critical";
  status: "unconfirmed" | "confirmed" | "ruled_out";
  /** Estimated chance this issue affects THIS unit, from age/km depth into the risk window. */
  likelihood: "low" | "medium" | "high";
  typicalRepairCostEur?: { min: number; max: number };
  /** What settles it: seller evidence or in-person checks. */
  verifyBy: string[];
}

export interface ConfidenceVerdict {
  overall: ConfidenceGrade;
  /**
   * Weighted 0–100 score (attractiveness given current knowledge). The grade
   * is its banded display: A≥85 B≥70 C≥55 D≥40 E<40. Vetoes (scam signals,
   * confirmed critical issues) override both — hard limits are code.
   */
  score: number;
  /**
   * How much of the assessment is verified (0–100): separate axis from the
   * score. Two B-cars can differ wildly here; seller answers raise it.
   */
  confidencePct: number;
  factors: {
    modelReliability: VerdictFactor;
    unitEvidence: VerdictFactor;
    sellerCredibility: VerdictFactor;
    priceFairness: VerdictFactor;
  };
  /** Dossier issues applicable to this unit, each with status and likelihood. */
  issues: IssueAssessment[];
  /** Sum of typical repair costs over non-ruled-out issues: the gamble, quantified. */
  repairExposureEur?: { min: number; max: number };
  /** Price + worst-case exposure vs the user's budget, stated plainly. */
  budgetNote?: string;
  /** Concrete, actionable: "invoice for timing belt change would raise unitEvidence to B". */
  wouldRaiseGrade: string[];
  /** Open questions for the seller, generated from the unit checklist. */
  openQuestions: string[];
  /**
   * Code-set veto tags ("scam_price", "critical_issue_confirmed", ...).
   * Kept on the verdict so caps can be reapplied deterministically after
   * any LLM refinement — vetoes are code, never negotiable by the model.
   */
  vetoes?: string[];
  /** LLM read of the ad text: refinement and color, never authority. */
  llm?: {
    /** 2–3 frases en español: qué es esta unidad y qué destaca del anuncio. */
    summary: string;
    /** One line unique to this unit: recommendation + best pro and worst con. */
    keyLine?: string;
    redFlags: string[];
    greenFlags: string[];
    /** Model id + timestamp: every AI claim is attributable. */
    model: string;
    at: string;
  };
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Model dossiers — reliability knowledge with receipts
// ---------------------------------------------------------------------------

/**
 * Zod schemas (not plain interfaces) because dossiers cross an untrusted
 * boundary: the automated builder drafts them with an LLM, and nothing
 * unvalidated may reach the database — same rule as normalizedListingSchema.
 */
export const knownIssueSchema = z.object({
  title: z.string(),
  description: z.string(),
  /**
   * When it typically bites. fuel/gearbox use canonical tokens matched
   * loosely against listing values: "diesel" | "gasoline", "automatic" | "manual".
   * A listing with the field missing counts as applicable (can't rule it out).
   */
  applicability: z.object({
    kmMin: z.number().optional(),
    kmMax: z.number().optional(),
    yearMin: z.number().optional(),
    yearMax: z.number().optional(),
    fuel: z.enum(["diesel", "gasoline"]).optional(),
    gearbox: z.enum(["automatic", "manual"]).optional(),
    powerCvMin: z.number().optional(),
    powerCvMax: z.number().optional(),
  }),
  typicalRepairCostEur: z.object({ min: z.number(), max: z.number() }).optional(),
  /** What evidence rules it in or out for a specific unit. */
  evidence: z.array(z.string()),
  /** Questions to put to the seller for this issue. */
  sellerQuestions: z.array(z.string()),
  severity: z.enum(["minor", "moderate", "major", "critical"]),
  sources: z.array(z.string()),
});
export type KnownIssue = z.infer<typeof knownIssueSchema>;

/**
 * A human-verified outcome for one known issue on one lead: the seller showed
 * evidence (or admitted the fault). Stored on the lead and applied on every
 * re-evaluation — evidence beats theory in both directions.
 */
export const issueFindingSchema = z.object({
  /** Identity: the dossier issue title this refers to. */
  title: z.string(),
  status: z.enum(["confirmed", "ruled_out"]),
  /** What evidence decided it (factura, vídeo del arranque, diagnosis…). */
  note: z.string().optional(),
  at: z.string(),
});
export type IssueFinding = z.infer<typeof issueFindingSchema>;

/**
 * Does a dossier keyed on `dossierModel` cover `model`? Exact match or word
 * prefix ("207" covers "207 rc") — listing/brief model fields carry seller
 * free text. Must stay in sync with getDossier's SQL (apps/web/lib/lookups).
 */
export function dossierCoversModel(dossierModel: string, model: string): boolean {
  const d = dossierModel.toLowerCase();
  const m = model.toLowerCase();
  return m === d || m.startsWith(`${d} `);
}

/**
 * Are two model strings the same family for price benchmarking? Symmetric
 * word-prefix ("207" ↔ "207 rc"): variants must share comparables or seller
 * free text fragments the sample. Trim/power weighting inside computeBenchmark
 * keeps the variants honestly separated. Mirrored in SQL by getBenchmark.
 */
export function sameModelFamily(a: string, b: string): boolean {
  return dossierCoversModel(a, b) || dossierCoversModel(b, a);
}

export const modelDossierSchema = z.object({
  make: z.string(),
  model: z.string(),
  generation: z.string().optional(),
  engineCode: z.string().optional(),
  knownIssues: z.array(knownIssueSchema),
  recalls: z.array(
    z.object({ title: z.string(), year: z.number().optional(), source: z.string() }),
  ),
  generalNotes: z.array(z.string()),
  sources: z.array(z.string()),
});
export type ModelDossier = z.infer<typeof modelDossierSchema>;

// ---------------------------------------------------------------------------
// Discovery — help the user find the right model(s) before any brief exists
// ---------------------------------------------------------------------------

/** The intake: what the user actually needs, structured but in their words. */
export const discoveryProfileSchema = z.object({
  budgetEur: z.number(),
  /** Free text: "diario ciudad + viajes", "juguete de findes"… */
  usage: z.string(),
  kmPerYear: z.number().optional(),
  seatsMin: z.number().optional(),
  fuelPreference: z.array(z.enum(["gasoline", "diesel", "hybrid", "electric"])).optional(),
  gearbox: z.enum(["manual", "automatic", "any"]).optional(),
  /** Ranked what-matters: "fiabilidad", "diversión", "coste de uso"… */
  priorities: z.array(z.string()),
  mustHaves: z.array(z.string()),
  dealBreakers: z.array(z.string()),
  notes: z.string().optional(),
});
export type DiscoveryProfile = z.infer<typeof discoveryProfileSchema>;

/** One concrete hunt proposal: specific enough to become a brief in one click. */
export const modelRecommendationSchema = z.object({
  make: z.string(),
  model: z.string(),
  /**
   * Representative photo of the recommended generation (real URL found during
   * research — Wikimedia preferred for hotlink stability). Buyers who don't
   * know the model by heart decide with their eyes first.
   */
  imageUrl: z.string().optional(),
  /** Trims/engines worth hunting ("1.6 THP 175", "GTI Performance DSG"). */
  versions: z.array(z.string()),
  /** Trims/engines to avoid, each with the reason inline. */
  avoidVersions: z.array(z.string()),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  /** Realistic Spanish second-hand band for the recommended config. */
  priceBandEur: z.object({ min: z.number(), max: z.number() }),
  whyFits: z.array(z.string()),
  /** Known weak points, one line each — the dossier deepens them later. */
  watchouts: z.array(z.string()),
  sources: z.array(z.string()),
});
export type ModelRecommendation = z.infer<typeof modelRecommendationSchema>;

/** Validated at the LLM trust boundary, whichever lane produced it. */
export const discoveryReportSchema = z.object({
  /** 2–3 frases: la lectura del perfil y el criterio del corte. */
  headline: z.string(),
  recommendations: z.array(modelRecommendationSchema).min(1).max(5),
  /** Models a user like this would expect to see, and why they lost. */
  discarded: z.array(z.object({ model: z.string(), reason: z.string() })),
  sources: z.array(z.string()),
});
export type DiscoveryReport = z.infer<typeof discoveryReportSchema>;

// ---------------------------------------------------------------------------
// LLM verdict enrichment — refinement, never authority
// ---------------------------------------------------------------------------

/** One bounded subscore refinement. Deltas are clamped in code (±MAX_ENRICHMENT_DELTA). */
export const factorAdjustmentSchema = z.object({
  delta: z.number(),
  /** Concrete evidence from the ad text, en español, justifying the delta. */
  reasons: z.array(z.string()),
});

/**
 * What the enrichment pass may contribute. Validated at the LLM trust
 * boundary; applyEnrichment() clamps deltas and reapplies vetoes after
 * merging — hard limits stay code, never prompt.
 */
export const llmEnrichmentPayloadSchema = z.object({
  /** 2–3 frases en español: qué es esta unidad y qué destaca del anuncio. */
  summary: z.string(),
  /**
   * One line UNIQUE to this unit (≤160 chars): clear recommendation plus its
   * biggest pro and con — the sentence a reader scans in a list of twenty.
   */
  keyLine: z.string().max(200).optional(),
  factorAdjustments: z.object({
    priceFairness: factorAdjustmentSchema.optional(),
    modelReliability: factorAdjustmentSchema.optional(),
    unitEvidence: factorAdjustmentSchema.optional(),
    sellerCredibility: factorAdjustmentSchema.optional(),
  }),
  redFlags: z.array(z.string()),
  greenFlags: z.array(z.string()),
  /** The ad smells like a scam (urgency, shipping, off-platform, impossible specs). */
  scamSuspicion: z.boolean(),
  scamReason: z.string().optional(),
  /** Only questions NOT already in the verdict, specific to this ad. */
  extraOpenQuestions: z.array(z.string()),
});
export type LlmEnrichmentPayload = z.infer<typeof llmEnrichmentPayloadSchema>;

/** Stored on the lead: the validated payload plus provenance set by code. */
export type LlmEnrichment = LlmEnrichmentPayload & { model: string; at: string };

// ---------------------------------------------------------------------------
// Conversation reading — seller replies become data, automatically
// ---------------------------------------------------------------------------

/**
 * One dossier issue moved by what the seller said. `basis` keeps the claim
 * honest: a seller's word and a shared document are both recorded, but the
 * note on the finding says which one it was — and findings stay reversible
 * from the lead page (Reabrir).
 */
export const conversationIssueUpdateSchema = z.object({
  /** Must match a verdict issue title exactly; unknown titles are dropped. */
  title: z.string(),
  status: z.enum(["confirmed", "ruled_out"]),
  basis: z.enum(["seller_stated", "evidence_shared"]),
  /** The seller's words that justify this, quoted from the conversation. */
  quote: z.string(),
});
export type ConversationIssueUpdate = z.infer<typeof conversationIssueUpdateSchema>;

/**
 * What a conversation read may contribute. Extends the ad-enrichment payload
 * (same bounded factorAdjustments, flags, summary — applyEnrichment merges
 * both identically) with conversation-only outcomes: issue findings, import
 * facts, and an escalation flag for the topics the agent must never handle
 * alone (payments, documents, off-platform moves — see ESCALATION_TRIGGERS).
 */
export const conversationReadingPayloadSchema = llmEnrichmentPayloadSchema.extend({
  issueUpdates: z.array(conversationIssueUpdateSchema),
  importFacts: z
    .object({
      rhd: z.boolean().optional(),
      foreignPlates: z.boolean().optional(),
      quote: z.string().optional(),
    })
    .optional(),
  /**
   * Live negotiation state, read from the transcript: the last number WE put
   * on the table and the seller's last counter. The reading only OBSERVES —
   * what to answer (and with which number) is decided by deterministic code
   * (respondToCounterEur), never by the model.
   */
  negotiation: z
    .object({
      ourLastOfferEur: z.number().positive().nullable().optional(),
      sellerLastOfferEur: z.number().positive().nullable().optional(),
      /** Buyer and seller are settling (or have settled) a visit day/time. */
      visitAgreed: z.boolean().optional(),
      quote: z.string().optional(),
    })
    .optional(),
  escalate: z.boolean(),
  escalateReason: z.string().optional(),
});
export type ConversationReadingPayload = z.infer<typeof conversationReadingPayloadSchema>;

/** Stored on the lead; structurally an LlmEnrichment so re-merges reuse applyEnrichment. */
export type ConversationReading = ConversationReadingPayload & { model: string; at: string };

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export type MessageDirection = "inbound" | "outbound";
export type MessageChannel = "wallapop_chat" | "email";
export type MessageStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "sent"
  | "received"
  | "failed";

/** Conversation topics that must always escalate to the user, never be improvised. */
export const ESCALATION_TRIGGERS = [
  "identity_question",
  "payment_or_deposit_request",
  "document_request",
  "off_platform_move",
  "shipping_offer",
  "unusual_behavior",
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];
