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
): EvaluationResult {
  // --- Hard filters: these kill the lead outright -------------------------
  if (!matchesVehicle(listing, criteria)) {
    return dead("different_vehicle", listing, benchmark);
  }
  if (listing.year !== undefined) {
    if (criteria.yearMin !== undefined && listing.year < criteria.yearMin) {
      return dead("year_below_minimum", listing, benchmark);
    }
    if (criteria.yearMax !== undefined && listing.year > criteria.yearMax) {
      return dead("year_above_maximum", listing, benchmark);
    }
  }
  if (
    listing.km !== undefined &&
    criteria.kmMax !== undefined &&
    listing.km > criteria.kmMax
  ) {
    return dead("km_over_limit", listing, benchmark);
  }
  if (
    listing.priceEur !== undefined &&
    listing.priceEur > hardLimits.maxPriceEur * NEGOTIATION_HEADROOM
  ) {
    return dead("price_over_budget", listing, benchmark);
  }

  return {
    outcome: "shortlisted",
    verdict: buildVerdict(listing, benchmark),
  };
}

function dead(
  reason: string,
  listing: NormalizedListing,
  benchmark?: PriceBenchmark,
): EvaluationResult {
  return { outcome: "dead", deadReason: reason, verdict: buildVerdict(listing, benchmark) };
}

function buildVerdict(
  listing: NormalizedListing,
  benchmark?: PriceBenchmark,
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

  // --- Model reliability: dossiers arrive later in Phase 1 ----------------
  const modelReliability: VerdictFactor = {
    grade: "C",
    known: [],
    assumed: [],
    unverified: ["Dossier de fiabilidad del modelo pendiente de construir"],
  };

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
    : {
        grade: "C",
        known: [],
        assumed: [],
        unverified: ["Reputación del vendedor sin analizar todavía"],
      };

  return {
    overall: worstOf(
      modelReliability.grade,
      unitEvidence.grade,
      sellerCredibility.grade,
      priceFairness.grade,
    ),
    factors: { modelReliability, unitEvidence, sellerCredibility, priceFairness },
    wouldRaiseGrade: [
      "Construir el dossier de fiabilidad del modelo",
      "Respuestas del vendedor sobre mantenimiento, propietarios y accidentes",
      ...(scamSignal ? ["Verificar que el vendedor y el vehículo son reales"] : []),
    ],
    openQuestions,
    updatedAt: new Date().toISOString(),
  };
}
