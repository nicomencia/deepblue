/**
 * Domain types for deepblue. Platform-agnostic and vendor-agnostic:
 * this package must never import a cloud SDK or a marketplace client.
 */

import { z } from "zod";

export const PLATFORMS = ["wallapop", "autoscout24"] as const;
export type Platform = (typeof PLATFORMS)[number];

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
