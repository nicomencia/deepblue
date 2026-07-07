/**
 * Rule-based listing evaluation: criteria matching, scam heuristics, price
 * fairness, and an honest confidence verdict. Pure and deterministic — the
 * LLM layer will later *refine* verdicts, but hard filters and scam floors
 * live here, in code (see PROJECT.md: hard limits are code, not prompt).
 */

import type {
  BriefCriteria,
  ConfidenceGrade,
  ConfidenceVerdict,
  HardLimits,
  KnownIssue,
  ModelDossier,
  NormalizedListing,
  VerdictFactor,
} from "./domain.js";

export interface PriceBenchmark {
  medianEur: number;
  sampleSize: number;
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

const GRADE_ORDER: readonly ConfidenceGrade[] = ["A", "B", "C", "D", "E"];

function worstOf(...grades: ConfidenceGrade[]): ConfidenceGrade {
  return grades.reduce((acc, g) =>
    GRADE_ORDER.indexOf(g) > GRADE_ORDER.indexOf(acc) ? g : acc,
  );
}

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
  if (!matchesVehicle(listing, criteria)) {
    return dead("different_vehicle", listing, benchmark, dossier);
  }
  if (listing.year !== undefined) {
    if (criteria.yearMin !== undefined && listing.year < criteria.yearMin) {
      return dead("year_below_minimum", listing, benchmark, dossier);
    }
    if (criteria.yearMax !== undefined && listing.year > criteria.yearMax) {
      return dead("year_above_maximum", listing, benchmark, dossier);
    }
  }
  if (
    listing.km !== undefined &&
    criteria.kmMax !== undefined &&
    listing.km > criteria.kmMax
  ) {
    return dead("km_over_limit", listing, benchmark, dossier);
  }
  if (
    listing.priceEur !== undefined &&
    listing.priceEur > hardLimits.maxPriceEur * NEGOTIATION_HEADROOM
  ) {
    return dead("price_over_budget", listing, benchmark, dossier);
  }

  return {
    outcome: "shortlisted",
    verdict: buildVerdict(listing, benchmark, dossier),
  };
}

function dead(
  reason: string,
  listing: NormalizedListing,
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
): EvaluationResult {
  return {
    outcome: "dead",
    deadReason: reason,
    verdict: buildVerdict(listing, benchmark, dossier),
  };
}

// ---------------------------------------------------------------------------
// Model reliability from the dossier (never from LLM memory — see PROJECT.md)
// ---------------------------------------------------------------------------

/** Issues approaching their mileage window count as applicable from 80% of kmMin. */
const KM_APPROACH_FACTOR = 0.8;

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

/**
 * Seller credibility from platform profile reputation (filled by detail
 * enrichment). Fresh zero-history profiles selling cars are a classic
 * scam pattern — graded cautiously, not accusatorially.
 */
function assessSeller(listing: NormalizedListing): VerdictFactor {
  const rating = listing.sellerRating;
  const reviews = listing.sellerReviewCount;
  if (rating === undefined || reviews === undefined) {
    return {
      grade: "C",
      known: [],
      assumed: [],
      unverified: ["Reputación del vendedor sin analizar todavía"],
    };
  }

  const sold = listing.sellerSoldCount;
  const profile = `${reviews} valoraciones${sold !== undefined ? `, ${sold} ventas` : ""}, media ${rating.toFixed(1)}/5`;

  if (reviews === 0 && (sold ?? 0) === 0) {
    return {
      grade: "D",
      known: ["Perfil sin historial: 0 valoraciones y 0 ventas"],
      assumed: [],
      unverified: ["Identidad del vendedor (perfil nuevo o inactivo)"],
    };
  }
  if (reviews >= 5 && rating >= 4.5) {
    return { grade: "B", known: [`Buen historial en la plataforma (${profile})`], assumed: [], unverified: [] };
  }
  if (reviews >= 5 && rating < 3.5) {
    return { grade: "D", known: [`Valoraciones bajas (${profile})`], assumed: [], unverified: [] };
  }
  return {
    grade: "C",
    known: [`Historial limitado en la plataforma (${profile})`],
    assumed: [],
    unverified: ["Reputación aún poco concluyente"],
  };
}

const SEVERITY_GRADE: Record<KnownIssue["severity"], ConfidenceGrade> = {
  minor: "B",
  moderate: "C",
  major: "D",
  critical: "E",
};

interface ReliabilityAssessment {
  factor: VerdictFactor;
  questions: string[];
  wouldRaise: string[];
}

function assessModelReliability(
  listing: NormalizedListing,
  dossier?: ModelDossier,
): ReliabilityAssessment {
  if (!dossier) {
    return {
      factor: {
        grade: "C",
        known: [],
        assumed: [],
        unverified: ["Dossier de fiabilidad del modelo pendiente de construir"],
      },
      questions: [],
      wouldRaise: ["Construir el dossier de fiabilidad del modelo"],
    };
  }

  const applicable = dossier.knownIssues.filter((issue) => issueApplies(listing, issue));
  if (applicable.length === 0) {
    return {
      factor: {
        grade: "B",
        known: [
          "Ningún problema conocido del modelo aplica a esta unidad (año/km/motor/cambio)",
        ],
        assumed: [],
        unverified: [],
      },
      questions: [],
      wouldRaise: [],
    };
  }

  // The grade reflects the worst applicable *model-level* risk; unit evidence
  // (invoices, seller answers) is what later rules each issue in or out.
  const grade = applicable
    .map((i) => SEVERITY_GRADE[i.severity])
    .reduce((acc, g) => worstOf(acc, g));

  const known = applicable.map((i) => {
    const cost = i.typicalRepairCostEur
      ? ` (~${i.typicalRepairCostEur.min.toLocaleString("es-ES")}–${i.typicalRepairCostEur.max.toLocaleString("es-ES")} €)`
      : "";
    return `${i.title}${cost}`;
  });

  return {
    factor: {
      grade,
      known,
      assumed: [],
      unverified: applicable.map((i) => `Sin descartar con evidencia: ${i.title}`),
    },
    questions: applicable.flatMap((i) => i.sellerQuestions),
    wouldRaise: applicable
      .slice(0, 3)
      .map((i) => `Evidencia que descartaría «${i.title}»: ${i.evidence.join("; ")}`),
  };
}

function buildVerdict(
  listing: NormalizedListing,
  benchmark?: PriceBenchmark,
  dossier?: ModelDossier,
): ConfidenceVerdict {
  const openQuestions: string[] = [];

  // --- Unit evidence: what the listing states vs what only the seller knows
  const known: string[] = [];
  const unverified: string[] = [];
  if (listing.year !== undefined) known.push(`Año declarado: ${listing.year}`);
  else {
    unverified.push("Año no indicado en el anuncio");
    openQuestions.push("¿De qué año es exactamente el coche?");
  }
  if (listing.gearbox !== undefined) known.push(`Cambio: ${listing.gearbox}`);
  else openQuestions.push("¿Es cambio manual o automático?");
  if (listing.powerCv !== undefined) known.push(`Potencia: ${listing.powerCv} CV`);
  if (listing.ecoLabel !== undefined)
    known.push(`Etiqueta ambiental: ${listing.ecoLabel.toUpperCase()}`);
  if (listing.km !== undefined) known.push(`Kilometraje declarado: ${listing.km.toLocaleString("es-ES")} km`);
  else {
    unverified.push("Kilometraje no indicado");
    openQuestions.push("¿Cuántos kilómetros tiene?");
  }
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
  const unitEvidence: VerdictFactor = {
    grade: "C",
    known,
    assumed: ["Los datos del anuncio son veraces (sin verificar)"],
    unverified,
  };

  // --- Model reliability: from the reviewed dossier, never from memory ----
  const reliability = assessModelReliability(listing, dossier);
  const modelReliability = reliability.factor;
  openQuestions.push(...reliability.questions);

  // --- Price fairness vs own corpus benchmark -----------------------------
  let priceFairness: VerdictFactor;
  let scamSignal = false;
  if (
    listing.priceEur !== undefined &&
    benchmark &&
    benchmark.sampleSize >= MIN_BENCHMARK_SAMPLE
  ) {
    const ratio = listing.priceEur / benchmark.medianEur;
    const pct = Math.round((1 - ratio) * 100);
    const desc = `Precio ${Math.abs(pct)}% ${pct >= 0 ? "por debajo" : "por encima"} de la mediana de ${benchmark.sampleSize} anuncios comparables (${Math.round(benchmark.medianEur).toLocaleString("es-ES")} €)`;
    let grade: ConfidenceGrade;
    if (ratio < SCAM_PRICE_RATIO) {
      grade = "E";
      scamSignal = true;
    } else if (ratio < 0.7) grade = "D"; // suspiciously cheap
    else if (ratio < 0.9) grade = "A";
    else if (ratio < 1.05) grade = "B";
    else grade = "C";
    priceFairness = { grade, known: [desc], assumed: [], unverified: [] };
  } else {
    priceFairness = {
      grade: "C",
      known: [],
      assumed: [],
      unverified: ["Sin comparables suficientes todavía para valorar el precio"],
    };
  }

  // --- Seller credibility --------------------------------------------------
  const sellerCredibility: VerdictFactor = scamSignal
    ? {
        grade: "E",
        known: ["Precio muy por debajo de mercado: señal clásica de estafa"],
        assumed: [],
        unverified: ["Identidad y reputación del vendedor"],
      }
    : assessSeller(listing);

  return {
    overall: worstOf(
      modelReliability.grade,
      unitEvidence.grade,
      sellerCredibility.grade,
      priceFairness.grade,
    ),
    factors: { modelReliability, unitEvidence, sellerCredibility, priceFairness },
    wouldRaiseGrade: [
      ...reliability.wouldRaise,
      "Respuestas del vendedor sobre mantenimiento, propietarios y accidentes",
      ...(scamSignal ? ["Verificar que el vendedor y el vehículo son reales"] : []),
    ],
    openQuestions: [...new Set(openQuestions)].slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}
