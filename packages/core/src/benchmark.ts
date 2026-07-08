/**
 * Price benchmark: weighted median over the model's corpus, where trim
 * dominates and year proximity refines. A 2015 base Golf must not price a
 * 2019 GTI — but with thin samples the benchmark degrades gracefully to the
 * coarse median instead of pretending precision it doesn't have.
 *
 * Pure and deterministic: the DB layer fetches comparables, this computes.
 */

export interface PriceBenchmark {
  medianEur: number;
  /** Effective sample (Kish) when weighted, raw count otherwise — feeds the min-sample guard. */
  sampleSize: number;
  /** Market the comparables come from — never compare ES prices to DE prices. */
  market?: string;
  /** Human-readable note on how comparables were weighted, for the verdict. */
  basis?: string;
}

/** Benchmarks from fewer (effective) comparables than this are noise; don't grade on them. */
export const MIN_BENCHMARK_SAMPLE = 8;

export interface Comparable {
  /** Effective price: cash price when the ad buried one, else the headline. */
  priceEur: number;
  year?: number;
  version?: string;
  powerCv?: number;
}

export interface BenchmarkTarget {
  version?: string;
  year?: number;
  powerCv?: number;
}

// --- Trim similarity ---------------------------------------------------------

/** Engine/tech noise that appears inside version strings but says nothing about trim. */
const NON_TRIM_TOKENS = new Set([
  "tsi", "tdi", "tgi", "tfsi", "etsi", "ehybrid", "hdi", "dci", "cdti", "crdi",
  "bmt", "bluemotion", "bm", "evo", "act", "ecotsi", "start", "stop",
]);

/**
 * Trim words of a version string: "Advance 1.6 TDI 110CV BMT DSG" → ["advance"].
 * GTI/GTD/R-Line style tokens survive — those ARE the trim.
 */
export function extractTrimTokens(version: string | undefined): string[] {
  if (!version) return [];
  return version
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(
      (t) =>
        t.length > 0 &&
        !NON_TRIM_TOKENS.has(t) &&
        !/^\d+(\.\d+)?$/.test(t) && // displacement / bare numbers
        !/^\d+(cv|kw|hp)$/.test(t) && // power figures
        !/^dsg\d*$/.test(t), // gearbox
    );
}

// --- Weighting ---------------------------------------------------------------

/** Trim agreement dominates: an explicit match outweighs years of distance. */
const TRIM_MATCH_WEIGHT = 4;
/** Both trims known but disjoint: still informs, discounted. */
const TRIM_MISMATCH_WEIGHT = 0.75;
/** Trim unknown but power within ±10%: the poor man's trim match. */
const POWER_MATCH_WEIGHT = 2;
/** Year decay: Δ0→1, Δ1→0.67, Δ2→0.5, Δ4→0.33. Gentler than the trim multiplier by design. */
const yearWeight = (delta: number): number => 1 / (1 + 0.5 * delta);
/** A comparable whose year we don't know is worth a bit less than a same-year one. */
const UNKNOWN_YEAR_WEIGHT = 0.6;

function comparableWeight(target: BenchmarkTarget, targetTrim: string[], comp: Comparable): number {
  let weight = 1;

  const compTrim = extractTrimTokens(comp.version);
  if (targetTrim.length > 0 && compTrim.length > 0) {
    const matches = targetTrim.some((t) => compTrim.includes(t));
    weight *= matches ? TRIM_MATCH_WEIGHT : TRIM_MISMATCH_WEIGHT;
  } else if (
    target.powerCv !== undefined &&
    comp.powerCv !== undefined &&
    Math.abs(comp.powerCv - target.powerCv) <= target.powerCv * 0.1
  ) {
    weight *= POWER_MATCH_WEIGHT;
  }

  if (target.year !== undefined && comp.year !== undefined) {
    weight *= yearWeight(Math.abs(comp.year - target.year));
  } else {
    weight *= UNKNOWN_YEAR_WEIGHT;
  }

  return weight;
}

// --- Median machinery ----------------------------------------------------------

function weightedMedian(rows: Array<{ price: number; weight: number }>): number {
  const sorted = [...rows].sort((a, b) => a.price - b.price);
  const half = sorted.reduce((s, r) => s + r.weight, 0) / 2;
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= half) return row.price;
  }
  return sorted[sorted.length - 1]?.price ?? 0;
}

/** Kish effective sample size: uniform weights → N; concentration shrinks it honestly. */
function effectiveSampleSize(weights: number[]): number {
  const sum = weights.reduce((s, w) => s + w, 0);
  const sumSq = weights.reduce((s, w) => s + w * w, 0);
  return sumSq === 0 ? 0 : (sum * sum) / sumSq;
}

/**
 * Weighted benchmark when the weighting keeps enough effective sample to be
 * trustworthy; otherwise the coarse median over everything (the caller's
 * min-sample guard still applies to that). Never both, never silently.
 */
export function computeBenchmark(
  target: BenchmarkTarget,
  comparables: Comparable[],
  market?: string,
): PriceBenchmark | undefined {
  if (comparables.length === 0) return undefined;

  const targetTrim = extractTrimTokens(target.version);
  const rows = comparables.map((c) => ({
    price: c.priceEur,
    weight: comparableWeight(target, targetTrim, c),
  }));

  const ess = effectiveSampleSize(rows.map((r) => r.weight));
  if (ess >= MIN_BENCHMARK_SAMPLE) {
    return {
      medianEur: weightedMedian(rows),
      sampleSize: Math.round(ess),
      market,
      basis: `mediana ponderada por acabado y año sobre ${comparables.length} anuncios del modelo`,
    };
  }

  return {
    medianEur: weightedMedian(rows.map((r) => ({ ...r, weight: 1 }))),
    sampleSize: comparables.length,
    market,
  };
}
