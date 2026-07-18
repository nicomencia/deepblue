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

export interface EvaluationResult {
  outcome: "shortlisted" | "dead";
  deadReason?: string;
  verdict: ConfidenceVerdict;
}

/** Asking prices above budget by up to this factor are kept — that's negotiation room. */
export const NEGOTIATION_HEADROOM = 1.15;
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

  const deadReason = hardFilterReason(listing, criteria, hardLimits, imported);
  const verdict = buildVerdict(listing, criteria, hardLimits, imported, benchmark, dossier, findings);
  if (deadReason) return { outcome: "dead", deadReason, verdict };
  return { outcome: "shortlisted", verdict };
}

function hardFilterReason(
  listing: NormalizedListing,
  criteria: BriefCriteria,
  hardLimits: HardLimits,
  imported: ImportSignals,
): string | undefined {
  if (!matchesVehicle(listing, criteria)) return "different_vehicle";
  // Import hard limits kill on FACTS (explicit text or user-verified), never
  // on the RHD assumption alone — dead leads don't resurrect, and the open
  // question resolves the assumption first.
  if (hardLimits.noRhd && imported.rhd && !imported.rhdAssumed) return "rhd_not_accepted";
  if (hardLimits.requireSpanishPlates && imported.foreignPlate) return "foreign_plates_not_accepted";
  if (listing.year !== undefined) {
    if (criteria.yearMin !== undefined && listing.year < criteria.yearMin) return "year_below_minimum";
    if (criteria.yearMax !== undefined && listing.year > criteria.yearMax) return "year_above_maximum";
  }
  if (listing.km !== undefined && criteria.kmMax !== undefined && listing.km > criteria.kmMax) {
    return "km_over_limit";
  }
  const price = effectivePrice(listing);
  if (price !== undefined && price > hardLimits.maxPriceEur * NEGOTIATION_HEADROOM) {
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
  const isChain = listing.sellerType === "dealer" && (sold ?? 0) >= CHAIN_SOLD_THRESHOLD;
  if (isChain) {
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
  if (paidPrice !== undefined && repairExposureEur) {
    const worstTotal = paidPrice + repairExposureEur.max;
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
