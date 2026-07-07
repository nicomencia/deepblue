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

import type {
  BriefCriteria,
  ConfidenceGrade,
  ConfidenceVerdict,
  HardLimits,
  IssueAssessment,
  KnownIssue,
  ModelDossier,
  NormalizedListing,
  RiskTolerance,
  VerdictFactor,
} from "./domain.js";

export interface PriceBenchmark {
  medianEur: number;
  sampleSize: number;
  /** Market the comparables come from — never compare ES prices to DE prices. */
  market?: string;
}

export interface EvaluationResult {
  outcome: "shortlisted" | "dead";
  deadReason?: string;
  verdict: ConfidenceVerdict;
}

/** Asking prices above budget by up to this factor are kept — that's negotiation room. */
export const NEGOTIATION_HEADROOM = 1.15;
/** Below this fraction of the market median, "bargain" reads as "scam" until proven otherwise. */
const SCAM_PRICE_RATIO = 0.55;
/** Benchmarks from fewer comparables than this are noise; don't grade on them. */
const MIN_BENCHMARK_SAMPLE = 8;
/** A subscore with nothing known sits here: neither reward nor punishment. */
const NEUTRAL = 55;

/**
 * Factor weights by risk tolerance. Gamblers weigh price harder and
 * theoretical (unconfirmed) risk softer; conservative buyers the reverse.
 */
const WEIGHTS: Record<RiskTolerance, { price: number; model: number; unit: number; seller: number }> = {
  low: { price: 0.25, model: 0.35, unit: 0.25, seller: 0.15 },
  medium: { price: 0.35, model: 0.25, unit: 0.25, seller: 0.15 },
  high: { price: 0.45, model: 0.15, unit: 0.25, seller: 0.15 },
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

function matchesVehicle(listing: NormalizedListing, criteria: BriefCriteria): boolean {
  const haystack = `${listing.make ?? ""} ${listing.model ?? ""} ${listing.title}`.toLowerCase();
  return criteria.vehicles.some(
    (v) => haystack.includes(v.make.toLowerCase()) && haystack.includes(v.model.toLowerCase()),
  );
}

export function evaluateListing(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
): EvaluationResult {
  // --- Hard filters: these kill the lead outright -------------------------
  const deadReason = hardFilterReason(listing, criteria, hardLimits);
  const verdict = buildVerdict(listing, criteria, hardLimits, benchmark, dossier);
  if (deadReason) return { outcome: "dead", deadReason, verdict };
  return { outcome: "shortlisted", verdict };
}

function hardFilterReason(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
): string | undefined {
  if (!matchesVehicle(listing, criteria)) return "different_vehicle";
  if (listing.year !== undefined) {
    if (criteria.yearMin !== undefined && listing.year < criteria.yearMin) return "year_below_minimum";
    if (criteria.yearMax !== undefined && listing.year > criteria.yearMax) return "year_above_maximum";
  }
  if (listing.km !== undefined && criteria.kmMax !== undefined && listing.km > criteria.kmMax) {
    return "km_over_limit";
  }
  if (
    listing.priceEur !== undefined &&
    listing.priceEur > hardLimits.maxPriceEur * NEGOTIATION_HEADROOM
  ) {
    return "price_over_budget";
  }
  return undefined;
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

const LIKELIHOOD_ES: Record<IssueAssessment["likelihood"], string> = {
  low: "probabilidad baja",
  medium: "probabilidad media",
  high: "probabilidad alta",
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
  const issues: IssueAssessment[] = applicableIssues.map((issue) => ({
    title: issue.title,
    severity: issue.severity,
    status: "unconfirmed", // seller answers move this to confirmed/ruled_out
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
  const priceRef = Math.max(listing.priceEur ?? 8000, 3000);
  const score = clamp(95 - (expectedCost / priceRef) * 250);

  const known = issues.map((i) => {
    const cost = i.typicalRepairCostEur
      ? `, ~${i.typicalRepairCostEur.min.toLocaleString("es-ES")}–${i.typicalRepairCostEur.max.toLocaleString("es-ES")} €`
      : "";
    return `${i.title} (${LIKELIHOOD_ES[i.likelihood]}${cost})`;
  });

  return {
    factor: {
      grade: scoreToGrade(score),
      score,
      known,
      assumed: [],
      unverified: issues
        .filter((i) => i.status === "unconfirmed")
        .map((i) => `Pendiente de verificar con el vendedor: ${i.title}`),
    },
    issues,
    questions: applicableIssues.flatMap((i) => i.sellerQuestions),
    wouldRaise: applicableIssues
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

function assessPrice(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  benchmark?: PriceBenchmark,
): { factor: VerdictFactor; scamSignal: boolean } {
  if (
    listing.priceEur === undefined ||
    !benchmark ||
    benchmark.sampleSize < MIN_BENCHMARK_SAMPLE
  ) {
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

  const ratio = listing.priceEur / benchmark.medianEur;
  const pct = Math.round((1 - ratio) * 100);
  const marketTag = benchmark.market ? ` en mercado ${benchmark.market.toUpperCase()}` : "";
  const known = [
    `Precio ${Math.abs(pct)}% ${pct >= 0 ? "por debajo" : "por encima"} de la mediana de ${benchmark.sampleSize} anuncios comparables${marketTag} (${Math.round(benchmark.medianEur).toLocaleString("es-ES")} €)`,
  ];

  const scamSignal = ratio < SCAM_PRICE_RATIO;
  // Linear: r=0.75 → 100, r=1.0 → 50, r=1.15 → 20. Suspiciously cheap
  // (below 0.70) caps at 45 — deep discounts are a flag, not a reward.
  let score = clamp(100 - (ratio - 0.75) * 200);
  if (ratio < 0.7) {
    score = Math.min(score, 45);
    known.push("Descuento inusualmente profundo: verificar antes de ilusionarse");
  }
  if (criteria.targetPriceEur !== undefined && listing.priceEur <= criteria.targetPriceEur) {
    score = clamp(score + 5);
    known.push(`Dentro de tu precio objetivo (${criteria.targetPriceEur.toLocaleString("es-ES")} €)`);
  }

  return {
    factor: { grade: scoreToGrade(score), score, known, assumed: [], unverified: [] },
    scamSignal,
  };
}

// ---------------------------------------------------------------------------
// Seller credibility from platform reputation
// ---------------------------------------------------------------------------

function assessSeller(listing: NormalizedListing): VerdictFactor {
  const rating = listing.sellerRating;
  const reviews = listing.sellerReviewCount;
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

  return {
    grade: scoreToGrade(score),
    score,
    known: [note],
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
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
): ConfidenceVerdict {
  const openQuestions: string[] = [];

  const unitEvidence = assessUnit(listing, criteria, openQuestions);
  const reliability = assessModelReliability(listing, dossier);
  openQuestions.push(...reliability.questions);
  const price = assessPrice(listing, criteria, benchmark);
  const sellerCredibility = price.scamSignal
    ? {
        grade: "E" as ConfidenceGrade,
        score: 10,
        known: ["Precio muy por debajo de mercado: señal clásica de estafa"],
        assumed: [],
        unverified: ["Identidad y reputación del vendedor"],
      }
    : assessSeller(listing);

  // --- Weighted overall score ----------------------------------------------
  const w = WEIGHTS[criteria.riskTolerance ?? "medium"];
  let score = clamp(
    price.factor.score * w.price +
      reliability.factor.score * w.model +
      unitEvidence.score * w.unit +
      sellerCredibility.score * w.seller,
  );

  // --- Vetoes: code, not weights -------------------------------------------
  if (price.scamSignal) score = Math.min(score, 20); // → E
  if (reliability.criticalConfirmed) score = Math.min(score, 45); // → D at best

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
  if (listing.priceEur !== undefined && repairExposureEur) {
    const worstTotal = listing.priceEur + repairExposureEur.max;
    budgetNote =
      worstTotal <= hardLimits.maxPriceEur
        ? `Incluso asumiendo el peor caso de reparaciones (~${repairExposureEur.max.toLocaleString("es-ES")} €), el total (~${worstTotal.toLocaleString("es-ES")} €) queda dentro de tu presupuesto de ${hardLimits.maxPriceEur.toLocaleString("es-ES")} €`
        : `Peor caso de reparaciones ~${repairExposureEur.max.toLocaleString("es-ES")} € → total ~${worstTotal.toLocaleString("es-ES")} €, por encima de tu presupuesto de ${hardLimits.maxPriceEur.toLocaleString("es-ES")} € — valorar solo si se descartan riesgos con el vendedor`;
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
    wouldRaiseGrade: [
      ...reliability.wouldRaise,
      "Respuestas del vendedor sobre mantenimiento, propietarios y accidentes",
      ...(price.scamSignal ? ["Verificar que el vendedor y el vehículo son reales"] : []),
    ],
    openQuestions: [...new Set(openQuestions)].slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}
