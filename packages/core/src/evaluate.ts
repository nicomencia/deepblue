/**
 * Listing evaluation: hard filters, weighted scoring, and an honest
 * confidence verdict. Pure and deterministic — the LLM layer will later
 * *refine* subscores, but hard filters and vetoes live here, in code
 * (see PROJECT.md: hard limits are code, not prompt).
 *
 * Two separate axes, never conflated:
 *  - score (0–100): how attractive the unit looks given current knowledge —
 *    weighted subscores, differentiates units.
 *  - confidencePct (0–100): how much of that knowledge is verified —
 *    identical-looking cars can differ wildly here.
 */

import { MIN_BENCHMARK_SAMPLE, type PriceBenchmark } from "./benchmark.js";
import { extractImportSignals, type ImportSignals } from "./extract.js";
import type {
  BriefCriteria,
  ConfidenceGrade,
  ConfidenceVerdict,
  HardLimits,
  IssueAssessment,
  IssueFinding,
  KnownIssue,
  LlmEnrichment,
  ModelDossier,
  NormalizedListing,
  RiskTolerance,
  VerdictFactor,
} from "./domain.js";

/** Which elastic limit a near miss overshot, and by how much. */
export interface NearMiss {
  reason: string;
  /** The brief's boundary and the unit's actual value, in that limit's units. */
  limit: number;
  actual: number;
  /** Overshoot as a fraction of the boundary (0.08 = 8% over). */
  overshoot: number;
}

export interface EvaluationResult {
  outcome: "shortlisted" | "near_miss" | "dead";
  /** Set on dead AND near_miss — in both cases, why this is not shortlisted. */
  deadReason?: string;
  nearMiss?: NearMiss;
  verdict: ConfidenceVerdict;
}

/** Asking prices above budget by up to this factor are kept — that's negotiation room. */
export const NEGOTIATION_HEADROOM = 1.15;
/**
 * How far past a shortlist boundary an ELASTIC limit may stretch and still be
 * worth surfacing. Applied on top of each boundary, so the price band compounds
 * with the negotiation headroom above. Background constant on purpose: the user
 * sets round numbers ("6.500", "180.000 km"), not tolerances — a unit 8% over a
 * round number is a fact about the market, not a preference to configure.
 */
export const NEAR_MISS_STRETCH = 1.15;
/** Year boundaries stretch in whole years; a ratio on a calendar year is meaningless. */
export const NEAR_MISS_YEAR_SLACK = 1;
/** Below this fraction of the market median, "bargain" reads as "scam" until proven otherwise. */
const SCAM_PRICE_RATIO = 0.55;
/** A subscore with nothing known sits here: neither reward nor punishment. */
const NEUTRAL = 55;

/**
 * Factor weights by risk tolerance. Gamblers weigh price harder and
 * theoretical (unconfirmed) risk softer; conservative buyers the reverse.
 * Model weight is deliberately low: the user chose the model knowing its
 * reputation — this factor differentiates configurations (DSG vs manual,
 * diesel vs petrol at high km), it must not re-punish the model choice.
 */
const WEIGHTS: Record<RiskTolerance, { price: number; model: number; unit: number; seller: number }> = {
  low: { price: 0.3, model: 0.25, unit: 0.3, seller: 0.15 },
  medium: { price: 0.4, model: 0.15, unit: 0.3, seller: 0.15 },
  high: { price: 0.5, model: 0.1, unit: 0.25, seller: 0.15 },
};

/** Grade bands over the weighted score. */
const GRADE_BANDS: ReadonlyArray<readonly [ConfidenceGrade, number]> = [
  ["A", 85],
  ["B", 70],
  ["C", 55],
  ["D", 40],
];

export function scoreToGrade(score: number): ConfidenceGrade {
  for (const [grade, min] of GRADE_BANDS) if (score >= min) return grade;
  return "E";
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * The price the buyer would actually pay: the parsed cash price when the ad
 * buried one (financing-conditional headlines), else the headline itself.
 */
const effectivePrice = (listing: NormalizedListing): number | undefined =>
  listing.cashPriceEur ?? listing.priceEur;

/**
 * Sellers do not type model names the way a brief does: "207RC", "207 R.C.",
 * "207-rc" and "Leon" for "León" are all the same car. Collapsing to bare
 * alphanumerics makes every spelling compare equal.
 *
 * This trades a rare false positive (two tokens fusing into a third — "G Turbo"
 * reading as "GT") for never again silently discarding the exact car the user
 * is hunting. That trade is deliberate and asymmetric: a wrong car in the
 * shortlist is visible and one click to dismiss, while a missed one is invisible
 * and, because dead leads stay dead, permanent.
 */
export function normalizeVehicleText(s: string): string {
  return s
    .toLowerCase()
    // NFD splits "ó" into "o" + a combining mark, which the alphanumeric
    // filter below then drops — so "león" and "leon" normalize alike.
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The same text as whole words, each normalized on its own — "GT-Line" gives
 * ["gt","line"]. Needed because the fused form above cannot tell a word from a
 * fragment: "gr" lives inside "gris", so a grey Yaris would read as a GR Yaris.
 */
export function vehicleTokens(s: string): string[] {
  // Split the RAW text, then normalize each piece: splitting after the NFD pass
  // would let the accent in "león" act as a separator and yield ["leo","n"].
  return s.split(/[\s\-_/.,()]+/).map(normalizeVehicleText).filter(Boolean);
}

/**
 * Trim packages that borrow a performance model's badge. Every manufacturer
 * does this on purpose — the halo sells the trim — so the words overlap while
 * the cars have nothing to do with each other: a "Yaris 1.5 Hybrid GR Sport"
 * (130 CV, front-wheel drive, a styling pack) is not a GR Yaris (261 CV, AWD,
 * rally homologation). Matching on scattered words alone cannot tell them
 * apart, so the decoy CONSUMES the word it borrowed.
 *
 * Extend this list, don't special-case at the call site: the pattern recurs
 * every time a maker sells a look-alike trim.
 */
const DECOY_BADGES: readonly (readonly string[])[] = [
  ["gr", "sport"], // Toyota GR Sport ≠ GR Yaris / GR86
  ["n", "line"], // Hyundai N Line ≠ i30 N
  ["m", "sport"], // BMW M Sport ≠ M3
  ["s", "line"], // Audi S line ≠ S3
  ["rs", "line"], // Audi RS line ≠ RS3
  ["amg", "line"], // Mercedes AMG Line ≠ A45 AMG
  ["r", "line"], // VW R-Line ≠ Golf R
  ["st", "line"], // Ford ST-Line ≠ Fiesta ST
  ["gt", "line"], // Peugeot/Kia GT Line ≠ GT / GTI
];

/**
 * Token positions spoken for by a decoy badge, so they cannot also satisfy the
 * model the user asked for. Skipped when the brief IS hunting that badge.
 */
function decoyIndices(tokens: string[], want: string[]): Set<number> {
  const consumed = new Set<number>();
  const wanted = want.join(" ");
  for (const badge of DECOY_BADGES) {
    if (wanted.includes(badge.join(" "))) continue;
    for (let i = 0; i + badge.length <= tokens.length; i++) {
      if (badge.every((w, k) => tokens[i + k] === w)) {
        for (let k = 0; k < badge.length; k++) consumed.add(i + k);
      }
    }
  }
  return consumed;
}

/**
 * Do the model's words appear TOGETHER, in any order, none of them on loan to a
 * decoy? Adjacency is what separates "Toyota Yaris GR" (the car) from "Toyota
 * Yaris 1.5 Hybrid GR Sport" (a trim three words further along).
 */
function hasAdjacentRun(tokens: string[], want: string[], consumed: Set<number>): boolean {
  const target = [...want].sort().join(" ");
  for (let i = 0; i + want.length <= tokens.length; i++) {
    let blocked = false;
    for (let k = 0; k < want.length; k++) if (consumed.has(i + k)) blocked = true;
    if (blocked) continue;
    if (tokens.slice(i, i + want.length).sort().join(" ") === target) return true;
  }
  return false;
}

/**
 * Does the listing's OWN model field name a strictly longer badge than the brief
 * asked for? "YARIS GR MN" contains "GR Yaris" and then some — it is the GRMN,
 * a different car wearing a superset of the words. "Yaris GR" is the same two
 * words reordered, which is just spelling.
 */
function namesLongerBadge(listingModel: string | undefined, want: string[]): boolean {
  if (!listingModel) return false;
  const own = vehicleTokens(listingModel);
  return own.length > want.length && want.every((t) => own.includes(t));
}

/** How well the unit answers to the model the brief is hunting. */
type ModelMatch = "exact" | "variant";

/**
 * A multi-word model name matches in ANY order, and `version` counts as much as
 * the title.
 *
 * Regression: a 31.000 € GR Yaris, 52 km from the search centre and inside every
 * limit, was killed as `different_vehicle` because Wallapop titled it "Toyota
 * Yaris GR" — the fused form gives "yarisgr", which does not contain "gryaris".
 * Its `version` field read "1.6 261 GR Yaris RZ 5p S/S" and was not even
 * consulted (2026-07-28).
 *
 * Word order is not information: nobody selling a GR Yaris means a different car
 * by writing "Yaris GR". But the words must be TOGETHER and must be their own
 * ("gr" hides inside "gris", and "GR Sport" borrows it), and a listing whose own
 * model field names a longer badge is a `variant` — real enough to show, never
 * confident enough to head the list.
 */
function classifyVehicleMatch(
  listing: NormalizedListing,
  criteria: BriefCriteria,
): ModelMatch | undefined {
  const text = `${listing.make ?? ""} ${listing.model ?? ""} ${listing.version ?? ""} ${listing.title}`;
  const haystack = normalizeVehicleText(text);
  const tokens = vehicleTokens(text);

  for (const v of criteria.vehicles) {
    if (!haystack.includes(normalizeVehicleText(v.make))) continue;
    const want = vehicleTokens(v.model);
    // The fused form is contiguous evidence and needs no adjacency check; only
    // a scattered multi-word name can have been scrambled or borrowed.
    const matched =
      haystack.includes(normalizeVehicleText(v.model)) ||
      (want.length > 1 && hasAdjacentRun(tokens, want, decoyIndices(tokens, want)));
    if (matched) return namesLongerBadge(listing.model, want) ? "variant" : "exact";
  }
  return undefined;
}

export function evaluateListing(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
  findings?: IssueFinding[],
): EvaluationResult {
  // --- Hard filters: these kill the lead outright -------------------------
  // Import facts: an explicit value on the listing (user-verified or set at
  // ingest) always beats text inference; the assumption flag only survives
  // while nothing explicit is known.
  const extracted = extractImportSignals(listing.title, listing.description);
  const imported: ImportSignals = {
    rhd: listing.rhd ?? extracted.rhd,
    rhdAssumed: listing.rhd === undefined && extracted.rhdAssumed,
    foreignPlate: listing.foreignPlates ?? extracted.foreignPlate,
  };

  const modelMatch = classifyVehicleMatch(listing, criteria);
  const verdict = buildVerdict(
    listing,
    criteria,
    hardLimits,
    imported,
    modelMatch,
    benchmark,
    dossier,
    findings,
  );

  // Absolute limits first: no band, no notification, no second look.
  const killed = absoluteKillReason(listing, criteria, hardLimits, imported, modelMatch);
  if (killed) return { outcome: "dead", deadReason: killed, verdict };

  // Then elastic limits, which have a stretch band beyond the boundary.
  const found = elasticMiss(listing, criteria, hardLimits);
  if (!found) return { outcome: "shortlisted", verdict };
  if (found.beyondBand) {
    return { outcome: "dead", deadReason: found.miss.reason, verdict };
  }
  return { outcome: "near_miss", deadReason: found.miss.reason, nearMiss: found.miss, verdict };
}

/**
 * Limits that admit no degree: the unit is simply not what the user will buy.
 * A right-hand-drive import at a great price is not a near miss, it is a no —
 * surfacing it would hollow out the hard-limits invariant (PROJECT.md).
 */
function absoluteKillReason(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
  imported: ImportSignals,
  modelMatch: ModelMatch | undefined,
): string | undefined {
  if (!modelMatch) return "different_vehicle";
  // Import hard limits kill on FACTS (explicit text or user-verified), never
  // on the RHD assumption alone — dead leads don't resurrect, and the open
  // question resolves the assumption first.
  if (hardLimits.noRhd && imported.rhd && !imported.rhdAssumed) return "rhd_not_accepted";
  if (hardLimits.requireSpanishPlates && imported.foreignPlate) return "foreign_plates_not_accepted";
  return undefined;
}

/** How far past a boundary the stretch band reaches, rounded to a whole unit. */
const bandEdge = (boundary: number): number => Math.round(boundary * NEAR_MISS_STRETCH);

/**
 * Limits that are a matter of degree. Inside the boundary the lead is
 * shortlisted; past it, `beyondBand` separates a near miss from a death.
 * Bands are compared against rounded absolute edges rather than ratios —
 * `1.15 - 1` is not 0.15 in binary floating point, and a unit sitting exactly
 * on a round boundary must not fall through the crack that opens.
 */
function elasticMiss(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
): { miss: NearMiss; beyondBand: boolean } | undefined {
  const over = (
    reason: string,
    limit: number,
    actual: number,
    beyondBand: boolean,
  ): { miss: NearMiss; beyondBand: boolean } => ({
    miss: {
      reason,
      limit,
      actual,
      overshoot: limit === 0 ? Number.POSITIVE_INFINITY : Math.abs(actual - limit) / limit,
    },
    beyondBand,
  });

  if (listing.year !== undefined) {
    // Years stretch by whole years — a percentage of a calendar year is meaningless.
    if (criteria.yearMin !== undefined && listing.year < criteria.yearMin) {
      const behind = criteria.yearMin - listing.year;
      return over("year_below_minimum", criteria.yearMin, listing.year, behind > NEAR_MISS_YEAR_SLACK);
    }
    if (criteria.yearMax !== undefined && listing.year > criteria.yearMax) {
      const ahead = listing.year - criteria.yearMax;
      return over("year_above_maximum", criteria.yearMax, listing.year, ahead > NEAR_MISS_YEAR_SLACK);
    }
  }
  if (listing.km !== undefined && criteria.kmMax !== undefined && listing.km > criteria.kmMax) {
    return over("km_over_limit", criteria.kmMax, listing.km, listing.km > bandEdge(criteria.kmMax));
  }
  // The budget boundary already includes negotiation headroom; the stretch
  // band sits beyond it, so an asking price can be over budget twice over
  // before it stops being worth a look.
  // No budget = a market-watch brief: nothing can be "over" a limit that was
  // never set, so every price is shown and the market answers the question.
  const price = effectivePrice(listing);
  if (hardLimits.maxPriceEur !== undefined) {
    const budget = Math.round(hardLimits.maxPriceEur * NEGOTIATION_HEADROOM);
    if (price !== undefined && price > budget) {
      return over("price_over_budget", budget, price, price > bandEdge(budget));
    }
  }
  // Wallapop's API ignores distance params (verified 2026-07-22, RECON.md),
  // so the search radius is enforced HERE. Facts only: listings without
  // coordinates pass (can't condemn on missing data), and the slack absorbs
  // city-centroid coordinates — sellers geocode to the town center.
  if (criteria.location && listing.lat !== undefined && listing.lon !== undefined) {
    const boundary = criteria.location.radiusKm + RADIUS_SLACK_KM;
    const distance = haversineKm(criteria.location, { lat: listing.lat, lon: listing.lon });
    if (distance > boundary) {
      return over("outside_search_radius", boundary, distance, distance > bandEdge(boundary));
    }
  }
  return undefined;
}

/** City-centroid coordinates put a village seller ~this far from their pin. */
const RADIUS_SLACK_KM = 15;

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------------------
// Model reliability from the dossier (never from LLM memory — see PROJECT.md)
// ---------------------------------------------------------------------------

/** Issues approaching their mileage window count as applicable from 80% of kmMin. */
const KM_APPROACH_FACTOR = 0.8;

/** Probability mass per likelihood bucket, for expected-repair-cost math. */
const LIKELIHOOD_P: Record<IssueAssessment["likelihood"], number> = {
  low: 0.3,
  medium: 0.55,
  high: 0.8,
};

function fieldMatches(value: string | undefined, token: string): boolean {
  // Unknown field → can't rule the issue out → applicable.
  if (value === undefined) return true;
  const v = value.toLowerCase();
  if (token === "diesel") return v.includes("diesel") || v.includes("diésel");
  if (token === "gasoline") return v.includes("gasolin"); // "gasoline" / "gasolina"
  if (token === "automatic") return v.includes("auto") || v.includes("dsg");
  if (token === "manual") return v.includes("man");
  return true;
}

function issueApplies(listing: NormalizedListing, issue: KnownIssue): boolean {
  const a = issue.applicability;
  if (a.fuel && !fieldMatches(listing.fuel, a.fuel)) return false;
  if (a.gearbox && !fieldMatches(listing.gearbox, a.gearbox)) return false;
  if (listing.year !== undefined) {
    if (a.yearMin !== undefined && listing.year < a.yearMin) return false;
    if (a.yearMax !== undefined && listing.year > a.yearMax) return false;
  }
  if (listing.km !== undefined) {
    if (a.kmMin !== undefined && listing.km < a.kmMin * KM_APPROACH_FACTOR) return false;
    if (a.kmMax !== undefined && listing.km > a.kmMax) return false;
  }
  if (listing.powerCv !== undefined) {
    if (a.powerCvMin !== undefined && listing.powerCv < a.powerCvMin) return false;
    if (a.powerCvMax !== undefined && listing.powerCv > a.powerCvMax) return false;
  }
  return true;
}

/** How likely this issue affects THIS unit, from km depth into the risk window. */
function likelihoodFor(listing: NormalizedListing, issue: KnownIssue): IssueAssessment["likelihood"] {
  const kmMin = issue.applicability.kmMin;
  if (kmMin !== undefined && listing.km !== undefined) {
    if (listing.km < kmMin) return "low"; // approaching the window (80% rule)
    if (listing.km < kmMin * 1.5) return "medium";
    return "high";
  }
  return "medium"; // can't narrow it down — say so honestly
}

interface ReliabilityAssessment {
  factor: VerdictFactor;
  issues: IssueAssessment[];
  questions: string[];
  wouldRaise: string[];
  /** true when a confirmed critical issue must veto the overall grade */
  criticalConfirmed: boolean;
}

/**
 * Theory never kills a lead (PROJECT.md): unconfirmed issues subtract
 * likelihood-weighted *expected repair cost* relative to the asking price —
 * quantified risk, not binary discard. Confirmed issues subtract their full
 * cost; ruled-out issues subtract nothing (evidence beats theory both ways).
 */
function assessModelReliability(
  listing: NormalizedListing,
  dossier?: ModelDossier,
  findings?: IssueFinding[],
): ReliabilityAssessment {
  if (!dossier) {
    return {
      factor: {
        grade: scoreToGrade(NEUTRAL),
        score: NEUTRAL,
        known: [],
        assumed: [],
        unverified: ["Dossier de fiabilidad del modelo pendiente de construir"],
      },
      issues: [],
      questions: [],
      wouldRaise: ["Construir el dossier de fiabilidad del modelo"],
      criticalConfirmed: false,
    };
  }

  const applicableIssues = dossier.knownIssues.filter((issue) => issueApplies(listing, issue));
  // Human-verified findings (seller evidence) override the default status;
  // the cost math below already prices each status correctly.
  const findingByTitle = new Map((findings ?? []).map((f) => [f.title, f.status]));
  const issues: IssueAssessment[] = applicableIssues.map((issue) => ({
    title: issue.title,
    severity: issue.severity,
    status: findingByTitle.get(issue.title) ?? "unconfirmed",
    likelihood: likelihoodFor(listing, issue),
    typicalRepairCostEur: issue.typicalRepairCostEur,
    verifyBy: issue.evidence,
  }));

  if (issues.length === 0) {
    return {
      factor: {
        grade: scoreToGrade(90),
        score: 90,
        known: ["Ningún problema conocido del modelo aplica a esta unidad (año/km/motor/cambio)"],
        assumed: [],
        unverified: [],
      },
      issues,
      questions: [],
      wouldRaise: [],
      criticalConfirmed: false,
    };
  }

  // Expected repair cost: full cost for confirmed issues, likelihood-weighted
  // midpoint for unconfirmed, zero for ruled_out.
  const expectedCost = issues.reduce((sum, i) => {
    if (i.status === "ruled_out" || !i.typicalRepairCostEur) return sum;
    const { min, max } = i.typicalRepairCostEur;
    if (i.status === "confirmed") return sum + max;
    return sum + LIKELIHOOD_P[i.likelihood] * (min + max) / 2;
  }, 0);

  // Normalize against the asking price: 1.000€ expected on a 10.000€ car
  // costs 25 points; the same risk on a 5.000€ car costs 50.
  const priceRef = Math.max(effectivePrice(listing) ?? 8000, 3000);
  const score = clamp(95 - (expectedCost / priceRef) * 250);

  // Exactly one summary line ("7/7 riesgos sin verificar"); the verdict's
  // issues[] is the single detailed view (status, likelihood, cost, evidence).
  const confirmed = issues.filter((i) => i.status === "confirmed").length;
  const ruledOut = issues.filter((i) => i.status === "ruled_out").length;
  const unconfirmed = issues.length - confirmed - ruledOut;
  const summaryParts = [
    `${unconfirmed}/${issues.length} riesgo${issues.length === 1 ? "" : "s"} del modelo sin verificar`,
  ];
  if (confirmed > 0) summaryParts.push(`${confirmed} confirmado${confirmed === 1 ? "" : "s"}`);
  if (ruledOut > 0) summaryParts.push(`${ruledOut} descartado${ruledOut === 1 ? "" : "s"}`);

  return {
    factor: {
      grade: scoreToGrade(score),
      score,
      known: [summaryParts.join(" · ")],
      assumed: [],
      unverified: [],
    },
    issues,
    // Only unresolved issues still generate seller questions and evidence asks.
    questions: applicableIssues
      .filter((_, idx) => issues[idx]?.status === "unconfirmed")
      .flatMap((i) => i.sellerQuestions),
    wouldRaise: applicableIssues
      .filter((_, idx) => issues[idx]?.status === "unconfirmed")
      .slice(0, 3)
      .map((i) => `Evidencia que descartaría «${i.title}»: ${i.evidence.join("; ")}`),
    criticalConfirmed: issues.some((i) => i.status === "confirmed" && i.severity === "critical"),
  };
}

// ---------------------------------------------------------------------------
// Unit condition signals — finally a factor that varies per unit
// ---------------------------------------------------------------------------

function assessUnit(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  openQuestions: string[],
): VerdictFactor {
  const known: string[] = [];
  const unverified: string[] = [];
  let score = 50;

  if (listing.year !== undefined) known.push(`Año declarado: ${listing.year}`);
  else {
    unverified.push("Año no indicado en el anuncio");
    openQuestions.push("¿De qué año es exactamente el coche?");
  }
  if (listing.km !== undefined) {
    known.push(`Kilometraje declarado: ${listing.km.toLocaleString("es-ES")} km`);
  } else {
    unverified.push("Kilometraje no indicado");
    openQuestions.push("¿Cuántos kilómetros tiene?");
  }

  // Usage intensity: km per year vs the ~15.000 km/año Spanish norm.
  if (listing.year !== undefined && listing.km !== undefined) {
    const age = Math.max(new Date().getFullYear() - listing.year, 1);
    const kmPerYear = listing.km / age;
    if (kmPerYear <= 10_000) {
      score += 20;
      known.push(`Uso suave: ~${Math.round(kmPerYear / 1000)}k km/año`);
    } else if (kmPerYear <= 16_000) {
      score += 10;
      known.push(`Uso normal: ~${Math.round(kmPerYear / 1000)}k km/año`);
    } else if (kmPerYear >= 25_000) {
      score -= 15;
      known.push(`Uso intensivo: ~${Math.round(kmPerYear / 1000)}k km/año`);
    }
  }

  // Mileage headroom vs the brief's ceiling.
  if (listing.km !== undefined && criteria.kmMax !== undefined) {
    const ratio = listing.km / criteria.kmMax;
    if (ratio <= 0.6) score += 10;
    else if (ratio >= 0.9) score -= 10;
  }

  // Data completeness: verified facts earn points; each unknown is a question.
  if (listing.gearbox !== undefined) {
    score += 5;
    known.push(`Cambio: ${listing.gearbox}`);
  } else openQuestions.push("¿Es cambio manual o automático?");
  // Only asked when the hunt actually cares. On a hatchback there is nothing
  // to choose, and a generic "4x2 or 4x4?" in the opener wastes the seller's
  // patience on a question whose answer changes nothing.
  if (criteria.drivetrain?.length) {
    if (listing.drivetrain !== undefined) {
      score += 5;
      known.push(`Tracción: ${listing.drivetrain}`);
    } else openQuestions.push("¿Es 4x2 o 4x4?");
  }
  if (listing.powerCv !== undefined) {
    score += 3;
    known.push(`Potencia: ${listing.powerCv} CV`);
  }
  if (listing.ecoLabel !== undefined) {
    score += 3;
    known.push(`Etiqueta ambiental: ${listing.ecoLabel.toUpperCase()}`);
  }
  if ((listing.description?.length ?? 0) >= 200) score += 4;

  unverified.push(
    "Historial de mantenimiento",
    "Número de propietarios",
    "Accidentes o reparaciones estructurales",
    "Estado de la ITV",
  );
  openQuestions.push(
    "¿Tiene el libro de mantenimiento al día? ¿Facturas de las revisiones?",
    "¿Cuántos propietarios ha tenido?",
    "¿Ha tenido algún accidente o reparación importante?",
    "¿Hasta cuándo tiene la ITV en vigor?",
  );

  const s = clamp(score);
  return {
    grade: scoreToGrade(s),
    score: s,
    known,
    assumed: ["Los datos del anuncio son veraces (sin verificar)"],
    unverified,
  };
}

// ---------------------------------------------------------------------------
// Price fairness vs own market-scoped benchmark
// ---------------------------------------------------------------------------

/** Re-registering a foreign-plated car in Spain: ITV homologación, tasas,
 * gestoría. Conservative — a post-Brexit UK import can add VAT + duty on top. */
const REMATRICULATION_COST_EUR = 1500;
/** RHD trades at a heavy discount here; LHD comparables flatter its price. */
const RHD_PRICE_PENALTY = 20;

function assessPrice(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  imported: ImportSignals,
  benchmark?: PriceBenchmark,
): { factor: VerdictFactor; scamSignal: boolean } {
  let price = effectivePrice(listing);
  if (price !== undefined && imported.foreignPlate) price += REMATRICULATION_COST_EUR;
  if (price === undefined || !benchmark || benchmark.sampleSize < MIN_BENCHMARK_SAMPLE) {
    return {
      factor: {
        grade: scoreToGrade(NEUTRAL),
        score: NEUTRAL,
        known: [],
        assumed: [],
        unverified: ["Sin comparables suficientes todavía para valorar el precio"],
      },
      scamSignal: false,
    };
  }

  const ratio = price / benchmark.medianEur;
  const pct = Math.round((1 - ratio) * 100);
  const marketTag = benchmark.market ? ` en mercado ${benchmark.market.toUpperCase()}` : "";
  const known = [
    `Precio ${Math.abs(pct)}% ${pct >= 0 ? "por debajo" : "por encima"} de la mediana de ${benchmark.sampleSize} anuncios comparables${marketTag} (${Math.round(benchmark.medianEur).toLocaleString("es-ES")} €)${benchmark.basis ? ` — ${benchmark.basis}` : ""}`,
  ];
  if (listing.cashPriceEur !== undefined && listing.priceEur !== undefined && listing.cashPriceEur !== listing.priceEur) {
    known.push(
      `Precio real al contado ${listing.cashPriceEur.toLocaleString("es-ES")} €: el anuncio lista ${listing.priceEur.toLocaleString("es-ES")} € condicionado a financiación`,
    );
  }

  const scamSignal = ratio < SCAM_PRICE_RATIO;
  // Linear: r=0.75 → 100, r=1.0 → 50, r=1.15 → 20. Suspiciously cheap
  // (below 0.70) caps at 45 — deep discounts are a flag, not a reward.
  let score = clamp(100 - (ratio - 0.75) * 200);
  if (ratio < 0.7) {
    score = Math.min(score, 45);
    known.push("Descuento inusualmente profundo: verificar antes de ilusionarse");
  }
  if (imported.foreignPlate) {
    known.push(
      `Matrícula extranjera: comparado sumando ~${REMATRICULATION_COST_EUR.toLocaleString("es-ES")} € de rematriculación (ITV, homologación, tasas — y si viene de UK, posible IVA y arancel encima)`,
    );
  }
  const assumed: string[] = [];
  if (imported.rhd) {
    score = clamp(score - RHD_PRICE_PENALTY);
    if (imported.rhdAssumed) {
      assumed.push(
        "Volante a la derecha asumido: coche de origen inglés sin mencionar volante izquierdo — los LHD con matrícula UK siempre lo anuncian",
      );
    } else {
      known.push(
        "Volante a la derecha (RHD): el mercado español lo descuenta con fuerza y la mediana de comparables LHD sobrevalora este anuncio",
      );
    }
  }
  if (criteria.targetPriceEur !== undefined && price <= criteria.targetPriceEur) {
    score = clamp(score + 5);
    known.push(`Dentro de tu precio objetivo (${criteria.targetPriceEur.toLocaleString("es-ES")} €)`);
  }

  return {
    factor: { grade: scoreToGrade(score), score, known, assumed, unverified: [] },
    scamSignal,
  };
}

// ---------------------------------------------------------------------------
// Seller credibility from platform reputation
// ---------------------------------------------------------------------------

/** Above this many platform sales a dealer reads as a compraventa chain. */
const CHAIN_SOLD_THRESHOLD = 1000;

/**
 * Credibility an official dealership does not have to earn on Wallapop.
 * Applied as a FLOOR, not a bonus: the guarantees come from the manufacturer's
 * network — warranty, certified mileage, multi-point inspection, a real address
 * and a company to claim against — and none of that depends on how many buyers
 * remembered to leave a star rating.
 */
const OFFICIAL_DEALER_FLOOR = 75;

/**
 * Is this the marque's own dealership selling its own brand?
 *
 * The signal is the seller NAME carrying the manufacturer's trademark while
 * selling that make: "Renault Jurado" listing a Renault. A business account
 * cannot trade under a marque's name without being in its network, which makes
 * this far harder to fake than the ad text — anyone can type "concesionario
 * oficial" into a description, so that is deliberately NOT trusted here.
 *
 * Matched on whole tokens: "Auto Seaton" must not read as a SEAT dealer. It
 * misses official dealers trading under a family name ("Automóviles Martín"),
 * and that asymmetry is the right one — under-claiming a guarantee is safe,
 * inventing one is not.
 */
export function isOfficialDealer(listing: NormalizedListing): boolean {
  if (listing.sellerType !== "dealer" || !listing.make || !listing.sellerName) return false;
  const make = normalizeVehicleText(listing.make);
  return make.length > 0 && vehicleTokens(listing.sellerName).includes(make);
}

function assessSeller(listing: NormalizedListing, criteria: BriefCriteria): VerdictFactor {
  const rating = listing.sellerRating;
  const reviews = listing.sellerReviewCount;
  const preferPrivate = criteria.sellerPreference === "prefer_private";

  if (rating === undefined || reviews === undefined) {
    return {
      grade: scoreToGrade(NEUTRAL),
      score: NEUTRAL,
      known: [],
      assumed: [],
      unverified: ["Reputación del vendedor sin analizar todavía"],
    };
  }

  const sold = listing.sellerSoldCount;
  const profile = `${reviews} valoraciones${sold !== undefined ? `, ${sold} ventas` : ""}, media ${rating.toFixed(1)}/5`;

  let score: number;
  let note: string;
  if (reviews === 0 && (sold ?? 0) === 0) {
    score = 30;
    note = "Perfil sin historial: 0 valoraciones y 0 ventas (patrón típico de estafa)";
  } else if (reviews >= 5 && rating >= 4.5) {
    score = reviews >= 20 ? 85 : 78;
    note = `Buen historial en la plataforma (${profile})`;
  } else if (reviews >= 5 && rating < 3.5) {
    score = 25;
    note = `Valoraciones bajas (${profile})`;
  } else {
    score = 55;
    note = `Historial limitado en la plataforma (${profile})`;
  }
  const known = [note];

  // Seller-type preference: encoded brief criteria, not prompt vibes.
  //
  // The marque's own dealership is its own category, NOT a compraventa: the
  // preference for particulares is a distrust of used-car chains, and it would
  // be wrong to aim it at the manufacturer's network. So an official dealer is
  // never treated as a chain and never carries the prefer-private penalty.
  const official = isOfficialDealer(listing);
  const isChain =
    !official && listing.sellerType === "dealer" && (sold ?? 0) >= CHAIN_SOLD_THRESHOLD;

  if (official) {
    known.push(
      `Concesionario oficial ${listing.make}: red del fabricante — garantía, kilometraje certificado y revisión multipunto, con empresa y dirección a la que reclamar`,
    );
    // Only when nothing contradicts it. Bad reviews of an official dealer are
    // still bad reviews, and this floor must not paint over them.
    if (rating >= 4) score = Math.max(score, OFFICIAL_DEALER_FLOOR);
  } else if (isChain) {
    known.push(`Compraventa de gran volumen (${(sold ?? 0).toLocaleString("es-ES")} ventas en la plataforma)`);
    if (preferPrivate) {
      score -= 20;
      known.push("Penalizado: prefieres particulares o vendedores pequeños");
    }
  } else if (preferPrivate && listing.sellerType === "private") {
    score += 5;
    known.push("Vendedor particular, como prefieres");
  }
  score = clamp(score);

  return {
    grade: scoreToGrade(score),
    score,
    known,
    assumed: [],
    unverified: reviews < 5 ? ["Reputación aún poco concluyente"] : [],
  };
}

// ---------------------------------------------------------------------------
// Verdict assembly: weighted score + separate confidence axis + vetoes
// ---------------------------------------------------------------------------

function buildVerdict(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
  imported: ImportSignals,
  modelMatch: ModelMatch | undefined,
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
  findings?: IssueFinding[],
): ConfidenceVerdict {
  const openQuestions: string[] = [];

  const unitEvidence = assessUnit(listing, criteria, openQuestions);
  const reliability = assessModelReliability(listing, dossier, findings);
  openQuestions.push(...reliability.questions);

  // Import signals (RHD / foreign plates) hit the price factor and always
  // deserve a direct question — sellers rarely volunteer the paperwork cost.
  if (imported.rhdAssumed) {
    openQuestions.unshift("¿El volante está a la derecha o a la izquierda?");
  }
  if (imported.foreignPlate) {
    openQuestions.unshift(
      "¿Quién asume la rematriculación en España (y aduanas/IVA si viene de UK)? ¿Qué documentación de importación tiene?",
    );
  } else if (imported.rhd) {
    openQuestions.unshift(
      "¿El coche está ya matriculado en España o sigue con matrícula extranjera?",
    );
  }

  const price = assessPrice(listing, criteria, imported, benchmark);
  const sellerCredibility = price.scamSignal
    ? {
        grade: "E" as ConfidenceGrade,
        score: 10,
        known: ["Precio muy por debajo de mercado: señal clásica de estafa"],
        assumed: [],
        unverified: ["Identidad y reputación del vendedor"],
      }
    : assessSeller(listing, criteria);

  // --- Weighted overall score ----------------------------------------------
  const w = WEIGHTS[criteria.riskTolerance ?? "medium"];
  let score = clamp(
    price.factor.score * w.price +
      reliability.factor.score * w.model +
      unitEvidence.score * w.unit +
      sellerCredibility.score * w.seller,
  );

  // --- Vetoes: code, not weights -------------------------------------------
  // Tagged on the verdict so applyEnrichment can reapply the caps after any
  // LLM refinement — the model can color inside these lines, never repaint them.
  const vetoes: string[] = [];
  if (price.scamSignal) vetoes.push("scam_price");
  if (reliability.criticalConfirmed) vetoes.push("critical_issue_confirmed");
  // A car whose own model field names a longer badge than the brief asked for
  // is shown, but capped. Otherwise the ones we CANNOT identify win the list:
  // they collect a neutral 55 on model reliability for want of a dossier, while
  // the real thing carries its dossier's unverified risks and scores 7.
  if (modelMatch === "variant") vetoes.push("model_variant");
  score = applyVetoCaps(score, vetoes);

  // --- Confidence axis: how much of this is verified ------------------------
  const issuesTotal = reliability.issues.length;
  const issuesResolved = reliability.issues.filter((i) => i.status !== "unconfirmed").length;
  const confidencePct = clamp(
    (listing.year !== undefined ? 10 : 0) +
      (listing.km !== undefined ? 10 : 0) +
      (listing.gearbox !== undefined ? 10 : 0) +
      (listing.powerCv !== undefined ? 5 : 0) +
      (listing.sellerRating !== undefined ? 15 : 0) +
      (dossier ? 15 : 0) +
      35 * (issuesTotal === 0 ? (dossier ? 1 : 0) : issuesResolved / issuesTotal),
  );

  // --- The gamble, quantified: repair exposure vs the user's budget ---------
  const liveIssues = reliability.issues.filter((i) => i.status !== "ruled_out");
  const costed = liveIssues.filter((i) => i.typicalRepairCostEur);
  const repairExposureEur =
    costed.length > 0
      ? {
          min: costed.reduce((s, i) => s + (i.typicalRepairCostEur?.min ?? 0), 0),
          max: costed.reduce((s, i) => s + (i.typicalRepairCostEur?.max ?? 0), 0),
        }
      : undefined;

  let budgetNote: string | undefined;
  const paidPrice = effectivePrice(listing);
  const maxPriceEur = hardLimits.maxPriceEur;
  // Without a declared budget the note still quantifies the gamble, it just
  // has nothing to compare it against — inventing a ceiling would be a lie.
  if (paidPrice !== undefined && repairExposureEur && maxPriceEur === undefined) {
    budgetNote = `Peor caso de reparaciones ~${repairExposureEur.max.toLocaleString("es-ES")} € → total ~${(paidPrice + repairExposureEur.max).toLocaleString("es-ES")} € (esta búsqueda no tiene presupuesto fijado)`;
  } else if (paidPrice !== undefined && repairExposureEur && maxPriceEur !== undefined) {
    const worstTotal = paidPrice + repairExposureEur.max;
    budgetNote =
      worstTotal <= maxPriceEur
        ? `Incluso asumiendo el peor caso de reparaciones (~${repairExposureEur.max.toLocaleString("es-ES")} €), el total (~${worstTotal.toLocaleString("es-ES")} €) queda dentro de tu presupuesto de ${maxPriceEur.toLocaleString("es-ES")} €`
        : `Peor caso de reparaciones ~${repairExposureEur.max.toLocaleString("es-ES")} € → total ~${worstTotal.toLocaleString("es-ES")} €, por encima de tu presupuesto de ${maxPriceEur.toLocaleString("es-ES")} € — valorar solo si se descartan riesgos con el vendedor`;
  }

  return {
    overall: scoreToGrade(score),
    score,
    confidencePct,
    factors: {
      modelReliability: reliability.factor,
      unitEvidence,
      sellerCredibility,
      priceFairness: price.factor,
    },
    issues: reliability.issues,
    repairExposureEur,
    budgetNote,
    vetoes,
    wouldRaiseGrade: [
      ...reliability.wouldRaise,
      "Respuestas del vendedor sobre mantenimiento, propietarios y accidentes",
      ...(price.scamSignal ? ["Verificar que el vendedor y el vehículo son reales"] : []),
    ],
    openQuestions: [...new Set(openQuestions)].slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// LLM enrichment merge — refinement, never authority
// ---------------------------------------------------------------------------

/** An LLM refinement moves a subscore at most this far, in either direction. */
export const MAX_ENRICHMENT_DELTA = 15;

/** Score ceilings per veto tag. llm_scam_suspicion only ever lowers — the safe direction. */
const VETO_CAPS: Record<string, number> = {
  scam_price: 20, // → E
  critical_issue_confirmed: 45, // → D at best
  llm_scam_suspicion: 45, // → D at best
  model_variant: 45, // → D at best: near the name you asked for, not the car
};

function applyVetoCaps(score: number, vetoes: string[]): number {
  for (const veto of vetoes) {
    const cap = VETO_CAPS[veto];
    if (cap !== undefined) score = Math.min(score, cap);
  }
  return score;
}

const FACTOR_KEYS = [
  "priceFairness",
  "modelReliability",
  "unitEvidence",
  "sellerCredibility",
] as const;

/**
 * Merge an LLM enrichment into a rule-based verdict. The model refines:
 * bounded subscore deltas with quoted ad evidence, red/green flags, extra
 * seller questions, a plain-Spanish summary. Code keeps authority: deltas
 * are clamped, weights and grade bands recomputed here, and veto caps
 * reapplied no matter what the model said. confidencePct is deliberately
 * untouched — reading the same unverified ad harder verifies nothing.
 * Deterministic, so it can be reapplied over every rule re-evaluation.
 */
export function applyEnrichment(
  verdict: ConfidenceVerdict,
  enrichment: LlmEnrichment,
  riskTolerance: RiskTolerance = "medium",
): ConfidenceVerdict {
  const factors = { ...verdict.factors };
  for (const key of FACTOR_KEYS) {
    const adjustment = enrichment.factorAdjustments[key];
    if (!adjustment || adjustment.delta === 0) continue;
    const delta = Math.max(
      -MAX_ENRICHMENT_DELTA,
      Math.min(MAX_ENRICHMENT_DELTA, adjustment.delta),
    );
    const score = clamp(factors[key].score + delta);
    factors[key] = {
      ...factors[key],
      score,
      grade: scoreToGrade(score),
      known: [...factors[key].known, ...adjustment.reasons],
    };
  }

  const w = WEIGHTS[riskTolerance];
  const vetoes = [...(verdict.vetoes ?? [])];
  if (enrichment.scamSuspicion && !vetoes.includes("llm_scam_suspicion")) {
    vetoes.push("llm_scam_suspicion");
  }
  const score = applyVetoCaps(
    clamp(
      factors.priceFairness.score * w.price +
        factors.modelReliability.score * w.model +
        factors.unitEvidence.score * w.unit +
        factors.sellerCredibility.score * w.seller,
    ),
    vetoes,
  );

  const scamFlag =
    enrichment.scamSuspicion && enrichment.scamReason
      ? [`Sospecha de estafa (IA): ${enrichment.scamReason}`]
      : [];

  return {
    ...verdict,
    overall: scoreToGrade(score),
    score,
    factors,
    vetoes,
    openQuestions: [
      ...new Set([...verdict.openQuestions, ...enrichment.extraOpenQuestions]),
    ].slice(0, 12),
    llm: {
      summary: enrichment.summary,
      // Chained merges (ad enrichment → chat reading): keep the last keyLine
      // seen, so a reading that omits it doesn't erase the ad's.
      keyLine: enrichment.keyLine ?? verdict.llm?.keyLine,
      redFlags: [...scamFlag, ...enrichment.redFlags],
      greenFlags: enrichment.greenFlags,
      model: enrichment.model,
      at: enrichment.at,
    },
    updatedAt: new Date().toISOString(),
  };
}
