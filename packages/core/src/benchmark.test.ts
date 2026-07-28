import { describe, expect, it } from "vitest";
import {
  computeBenchmark,
  extractTrimTokens,
  MIN_BENCHMARK_SAMPLE,
  type Comparable,
} from "./benchmark.js";

const comp = (priceEur: number, over: Partial<Comparable> = {}): Comparable => ({
  priceEur,
  year: 2018,
  ...over,
});

describe("extractTrimTokens", () => {
  it("keeps trim words and drops engine/tech noise", () => {
    expect(extractTrimTokens("Advance 1.0 TSI 85kW (115CV)")).toEqual(["advance"]);
    expect(extractTrimTokens("Advance 1.6 TDI 110CV BMT DSG")).toEqual(["advance"]);
    expect(extractTrimTokens("1.5 TSI Evo BM Advance 96kW")).toEqual(["advance"]);
    expect(extractTrimTokens("Business Edition 81kW")).toEqual(["business", "edition"]);
  });

  it("GTI-style tokens ARE the trim and survive", () => {
    expect(extractTrimTokens("2.0 TSI GTI Performance DSG7")).toEqual(["gti", "performance"]);
    expect(extractTrimTokens("GTD 2.0 TDI 184CV")).toEqual(["gtd"]);
  });

  it("returns empty for missing or engine-only versions", () => {
    expect(extractTrimTokens(undefined)).toEqual([]);
    expect(extractTrimTokens("1.6 TDI 105CV")).toEqual([]);
  });
});

describe("computeBenchmark", () => {
  it("returns undefined with no comparables", () => {
    expect(computeBenchmark({}, [])).toBeUndefined();
  });

  it("same-trim comparables dominate the median over other trims", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(12_000, { version: "Advance 1.0 TSI" })),
      ...Array.from({ length: 10 }, () => comp(20_000, { version: "GTI 2.0 TSI" })),
    ];
    const b = computeBenchmark({ version: "Advance 1.4 TSI", year: 2018 }, comps, "ES");
    // Unweighted the median would sit between the groups; trim weighting pins it to Advance.
    expect(b?.medianEur).toBe(12_000);
    expect(b?.basis).toContain("ponderada por acabado, motor, cambio y año");
    expect(b?.market).toBe("ES");
  });

  it("trim outweighs year: an old same-trim car beats a same-year other trim", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(12_000, { version: "Advance", year: 2015 })),
      ...Array.from({ length: 10 }, () => comp(20_000, { version: "GTI", year: 2018 })),
    ];
    const b = computeBenchmark({ version: "Advance", year: 2018 }, comps);
    // Advance@2015: 4 × 1/(1+1.5) = 1.6 each; GTI@2018: 0.75 × 1 each → Advance still wins.
    expect(b?.medianEur).toBe(12_000);
  });

  it("within the same trim, closer years pull the median", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(10_000, { version: "Advance", year: 2015 })),
      ...Array.from({ length: 10 }, () => comp(13_000, { version: "Advance", year: 2018 })),
    ];
    const b = computeBenchmark({ version: "Advance", year: 2018 }, comps);
    expect(b?.medianEur).toBe(13_000);
  });

  it("falls back to power proximity when trims are unknown", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(11_000, { version: undefined, powerCv: 110 })),
      ...Array.from({ length: 10 }, () => comp(19_000, { version: undefined, powerCv: 245 })),
    ];
    const b = computeBenchmark({ year: 2018, powerCv: 115 }, comps);
    expect(b?.medianEur).toBe(11_000);
  });

  it("degrades to the honest coarse median when weighting starves the sample", () => {
    // One same-trim comparable among many others: Kish ESS collapses below the
    // minimum → coarse median over everything, no weighting claim.
    const comps = [
      comp(9_000, { version: "Advance" }),
      ...Array.from({ length: 9 }, () => comp(15_000, { version: undefined, powerCv: undefined, year: undefined })),
    ];
    const b = computeBenchmark({ version: "Advance", year: 2018 }, comps);
    expect(b?.basis).toBeUndefined();
    expect(b?.medianEur).toBe(15_000);
    expect(b?.sampleSize).toBe(10);
  });

  it("prices a diesel against diesels, not the gasoline half of the pool", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(14_000, { fuel: "diesel" })),
      ...Array.from({ length: 10 }, () => comp(11_000, { fuel: "gasoline" })),
    ];
    // Same trim/year both sides: only fuel separates them. Diesel target pins it.
    const b = computeBenchmark({ year: 2018, fuel: "Diésel" }, comps);
    expect(b?.medianEur).toBe(14_000);
  });

  it("separates manual from automatic within the same engine", () => {
    const comps = [
      ...Array.from({ length: 10 }, () => comp(13_000, { fuel: "gasoline", gearbox: "manual" })),
      ...Array.from({ length: 10 }, () => comp(16_000, { fuel: "gasoline", gearbox: "automático" })),
    ];
    const b = computeBenchmark({ year: 2018, fuel: "gasolina", gearbox: "Manual" }, comps);
    expect(b?.medianEur).toBe(13_000);
  });

  it("unknown fuel stays neutral — no penalty, no fake match", () => {
    const comps = Array.from({ length: 10 }, () => comp(12_500, { fuel: "diesel" }));
    // Target fuel unknown: every comparable keeps weight 1, median is just theirs.
    const b = computeBenchmark({ year: 2018 }, comps);
    expect(b?.medianEur).toBe(12_500);
  });

  it("keeps the effective sample honest: uniform anonymous corpus ≈ raw count", () => {
    const comps = Array.from({ length: 20 }, () =>
      comp(14_000, { version: undefined, powerCv: undefined }),
    );
    const b = computeBenchmark({ version: "Advance", year: 2018 }, comps);
    expect(b?.sampleSize).toBe(20);
    expect(b?.sampleSize).toBeGreaterThanOrEqual(MIN_BENCHMARK_SAMPLE);
  });
});

describe("drivetrain in the benchmark", () => {
  // The unfairness Nico spotted: with 4x2 and 4x4 pooled, a 4x4 is priced
  // against cheaper cars and reads as overpriced, while a 4x2 is priced
  // against dearer ones and reads as a bargain. Same model, same year.
  const pool: Comparable[] = [
    ...Array.from({ length: 8 }, () => ({ priceEur: 20_000, year: 2022, drivetrain: "4x2" })),
    ...Array.from({ length: 8 }, () => ({ priceEur: 26_000, year: 2022, drivetrain: "4x4" })),
  ];
  const median = (t: Parameters<typeof computeBenchmark>[0], c: Comparable[] = pool) =>
    computeBenchmark(t, c)?.medianEur ?? 0;

  it("prices a 4x4 against 4x4s, not against the mixed pool", () => {
    expect(median({ year: 2022 })).toBeLessThan(median({ year: 2022, drivetrain: "4x4" }));
    expect(median({ year: 2022, drivetrain: "4x4" })).toBeGreaterThan(24_000);
  });

  it("prices a 4x2 against 4x2s, so it stops looking like a bargain", () => {
    expect(median({ year: 2022, drivetrain: "4x2" })).toBeLessThan(22_000);
  });

  it("reads the trade name on comparables that never say '4x4'", () => {
    const named = pool.map((c) => (c.drivetrain === "4x4" ? { ...c, drivetrain: "HTRAC" } : c));
    expect(median({ year: 2022, drivetrain: "4x4" }, named)).toBeGreaterThan(24_000);
  });

  it("stays neutral when the ads simply do not say", () => {
    // Most ads don't state it. An unknown drivetrain must not quietly
    // penalise every comparable whose seller didn't spell it out.
    const silent: Comparable[] = pool.map(({ priceEur, year }) => ({ priceEur, year }));
    expect(median({ year: 2022, drivetrain: "4x4" }, silent)).toBe(median({ year: 2022 }, silent));
  });
});
