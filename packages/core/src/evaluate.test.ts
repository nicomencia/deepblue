import { describe, expect, it } from "vitest";
import type {
  BriefCriteria,
  HardLimits,
  LlmEnrichment,
  ModelDossier,
  NormalizedListing,
} from "./domain.js";
import {
  applyEnrichment,
  evaluateListing,
  MAX_ENRICHMENT_DELTA,
  NEGOTIATION_HEADROOM,
  scoreToGrade,
  type PriceBenchmark,
} from "./evaluate.js";

// --- Fixtures ---------------------------------------------------------------

const listing = (overrides: Partial<NormalizedListing> = {}): NormalizedListing => ({
  platform: "wallapop",
  platformListingId: "t1",
  url: "https://example.com/item",
  title: "Volkswagen Golf 1.4 TSI",
  priceEur: 12_000,
  make: "Volkswagen",
  model: "Golf",
  year: 2018,
  km: 90_000,
  fuel: "Gasolina",
  gearbox: "Manual",
  powerCv: 125,
  countryCode: "ES",
  raw: {},
  ...overrides,
});

const criteria = (overrides: Partial<BriefCriteria> = {}): BriefCriteria => ({
  vehicles: [{ make: "Volkswagen", model: "Golf" }],
  yearMin: 2015,
  kmMax: 140_000,
  ...overrides,
});

const hardLimits: HardLimits = { maxPriceEur: 15_500, nonNegotiables: [] };
const benchmark: PriceBenchmark = { medianEur: 14_000, sampleSize: 20, market: "ES" };

const dossier = (issues: ModelDossier["knownIssues"]): ModelDossier => ({
  make: "Volkswagen",
  model: "Golf",
  knownIssues: issues,
  recalls: [],
  generalNotes: [],
  sources: ["https://example.com"],
});

const dsgIssue = {
  title: "DSG DQ200 mecatrónica",
  description: "Tirones y fallos",
  applicability: { gearbox: "automatic" as const, kmMin: 60_000 },
  typicalRepairCostEur: { min: 1_000, max: 2_000 },
  evidence: ["Factura aceite DSG"],
  sellerQuestions: ["¿Da tirones?"],
  severity: "major" as const,
  sources: ["https://example.com"],
};

// --- Grade bands --------------------------------------------------------------

describe("scoreToGrade", () => {
  it("bands scores at A≥85 B≥70 C≥55 D≥40 E<40", () => {
    expect(scoreToGrade(85)).toBe("A");
    expect(scoreToGrade(84)).toBe("B");
    expect(scoreToGrade(70)).toBe("B");
    expect(scoreToGrade(69)).toBe("C");
    expect(scoreToGrade(55)).toBe("C");
    expect(scoreToGrade(54)).toBe("D");
    expect(scoreToGrade(40)).toBe("D");
    expect(scoreToGrade(39)).toBe("E");
  });
});

// --- Hard filters -------------------------------------------------------------

describe("hard filters", () => {
  it("kills a different vehicle", () => {
    const r = evaluateListing(listing({ title: "Seat León FR", make: "Seat", model: "León" }), criteria(), hardLimits);
    expect(r.outcome).toBe("dead");
    expect(r.deadReason).toBe("different_vehicle");
  });

  it("kills year and km violations, tolerates unknown fields", () => {
    expect(evaluateListing(listing({ year: 2014 }), criteria(), hardLimits).deadReason).toBe("year_below_minimum");
    expect(evaluateListing(listing({ year: 2020 }), criteria({ yearMax: 2019 }), hardLimits).deadReason).toBe("year_above_maximum");
    expect(evaluateListing(listing({ km: 150_000 }), criteria(), hardLimits).deadReason).toBe("km_over_limit");
    expect(evaluateListing(listing({ year: undefined, km: undefined }), criteria(), hardLimits).outcome).toBe("shortlisted");
  });

  it("keeps asking prices within negotiation headroom, kills above it", () => {
    const cap = Math.round(hardLimits.maxPriceEur * NEGOTIATION_HEADROOM); // 17.825
    expect(evaluateListing(listing({ priceEur: cap }), criteria(), hardLimits).outcome).toBe("shortlisted");
    expect(evaluateListing(listing({ priceEur: cap + 1 }), criteria(), hardLimits).deadReason).toBe("price_over_budget");
  });

  it("budget-checks the real cash price, not the financing headline", () => {
    const r = evaluateListing(
      listing({ priceEur: 15_000, cashPriceEur: 18_500 }),
      criteria(),
      hardLimits,
    );
    expect(r.deadReason).toBe("price_over_budget");
  });
});

// --- Price fairness -----------------------------------------------------------

describe("price fairness", () => {
  const price = (l: NormalizedListing, b?: PriceBenchmark) =>
    evaluateListing(l, criteria(), hardLimits, b).verdict.factors.priceFairness;

  it("stays neutral without enough comparables", () => {
    const f = price(listing(), { medianEur: 14_000, sampleSize: 7 });
    expect(f.score).toBe(55);
    expect(f.unverified.length).toBeGreaterThan(0);
  });

  it("maps price/median ratio linearly: 0.75→100, 1.0→50", () => {
    expect(price(listing({ priceEur: 10_500 }), benchmark).score).toBe(100);
    expect(price(listing({ priceEur: 14_000 }), benchmark).score).toBe(50);
  });

  it("caps suspiciously deep discounts at 45 instead of rewarding them", () => {
    const f = price(listing({ priceEur: 8_400 }), benchmark); // ratio 0.6
    expect(f.score).toBe(45);
    expect(f.known.join(" ")).toContain("Descuento inusualmente profundo");
  });

  it("grades on the cash price and says so when the headline is financing bait", () => {
    const f = price(listing({ priceEur: 11_490, cashPriceEur: 13_490 }), benchmark);
    // ratio 13490/14000 ≈ 0.96 → ~57, far from the headline's fake 86
    expect(f.score).toBe(57);
    expect(f.known.join(" ")).toContain("Precio real al contado");
  });

  it("scam pricing vetoes the whole verdict: grade E, tagged, seller zeroed", () => {
    const r = evaluateListing(listing({ priceEur: 7_000 }), criteria(), hardLimits, benchmark); // ratio 0.5
    expect(r.outcome).toBe("shortlisted"); // visible, not hidden — graded E
    expect(r.verdict.overall).toBe("E");
    expect(r.verdict.score).toBeLessThanOrEqual(20);
    expect(r.verdict.vetoes).toContain("scam_price");
    expect(r.verdict.factors.sellerCredibility.grade).toBe("E");
  });
});

// --- Seller credibility -------------------------------------------------------

describe("seller credibility", () => {
  const seller = (l: Partial<NormalizedListing>, c: Partial<BriefCriteria> = {}) =>
    evaluateListing(listing(l), criteria(c), hardLimits).verdict.factors.sellerCredibility;

  it("is neutral until reputation is fetched", () => {
    expect(seller({}).score).toBe(55);
  });

  it("flags the classic 0-review 0-sale scam pattern", () => {
    const f = seller({ sellerRating: 0, sellerReviewCount: 0, sellerSoldCount: 0 });
    expect(f.score).toBe(30);
    expect(f.known.join(" ")).toContain("patrón típico de estafa");
  });

  it("rewards a long good history", () => {
    expect(seller({ sellerRating: 4.8, sellerReviewCount: 25, sellerSoldCount: 30 }).score).toBe(85);
  });

  it("detects compraventa chains and only penalizes them under prefer_private", () => {
    const chain = { sellerType: "dealer" as const, sellerRating: 0, sellerReviewCount: 0, sellerSoldCount: 5_000 };
    const indifferent = seller(chain);
    expect(indifferent.score).toBe(55);
    expect(indifferent.known.join(" ")).toContain("Compraventa de gran volumen");

    const penalized = seller(chain, { sellerPreference: "prefer_private" });
    expect(penalized.score).toBe(35);
    expect(penalized.known.join(" ")).toContain("prefieres particulares");
  });

  it("rewards particulares under prefer_private", () => {
    const f = seller(
      { sellerType: "private", sellerRating: 4.8, sellerReviewCount: 25, sellerSoldCount: 10 },
      { sellerPreference: "prefer_private" },
    );
    expect(f.score).toBe(90); // 85 + 5
  });
});

// --- Dossier issues on a unit ---------------------------------------------------

describe("model reliability from the dossier", () => {
  const reliability = (l: Partial<NormalizedListing>, d?: ModelDossier) =>
    evaluateListing(listing(l), criteria(), hardLimits, benchmark, d).verdict;

  it("is neutral without a dossier and asks for one", () => {
    const v = reliability({});
    expect(v.factors.modelReliability.score).toBe(55);
    expect(v.wouldRaiseGrade.join(" ")).toContain("dossier");
  });

  it("scores 90 when no known issue applies to this unit", () => {
    const v = reliability({ gearbox: "Manual", km: 100_000 }, dossier([dsgIssue]));
    expect(v.issues).toHaveLength(0);
    expect(v.factors.modelReliability.score).toBe(90);
  });

  it("matches gearbox tokens loosely: DSG counts as automatic", () => {
    const v = reliability({ gearbox: "DSG7", km: 100_000 }, dossier([dsgIssue]));
    expect(v.issues).toHaveLength(1);
  });

  it("treats a missing field as unable to rule the issue out", () => {
    const v = reliability({ gearbox: undefined, km: 100_000 }, dossier([dsgIssue]));
    expect(v.issues).toHaveLength(1);
  });

  it("applies the 80% approach window on kmMin and buckets likelihood by depth", () => {
    const auto = { gearbox: "Automático" };
    expect(reliability({ ...auto, km: 40_000 }, dossier([dsgIssue])).issues).toHaveLength(0); // < 48k
    expect(reliability({ ...auto, km: 50_000 }, dossier([dsgIssue])).issues[0]?.likelihood).toBe("low");
    expect(reliability({ ...auto, km: 70_000 }, dossier([dsgIssue])).issues[0]?.likelihood).toBe("medium");
    expect(reliability({ ...auto, km: 100_000 }, dossier([dsgIssue])).issues[0]?.likelihood).toBe("high");
  });

  it("subtracts likelihood-weighted expected repair cost relative to the price paid", () => {
    // medium likelihood (0.55) × midpoint 1.500 € = 825 € on a 10.000 € car → 95 − 20.6 ≈ 74
    const v = reliability({ gearbox: "Automático", km: 70_000, priceEur: 10_000 }, dossier([dsgIssue]));
    expect(v.factors.modelReliability.score).toBe(74);
  });

  it("quantifies the gamble: exposure range and a budget note on the cash price", () => {
    const v = reliability(
      { gearbox: "Automático", km: 100_000, priceEur: 12_000, cashPriceEur: 14_000 },
      dossier([dsgIssue]),
    );
    expect(v.repairExposureEur).toEqual({ min: 1_000, max: 2_000 });
    // 14.000 cash + 2.000 worst case = 16.000 > 15.500 budget → warns
    expect(v.budgetNote).toContain("por encima de tu presupuesto");
  });

  it("fuel gating excludes diesel-only issues from petrol units", () => {
    const dieselIssue = { ...dsgIssue, applicability: { fuel: "diesel" as const } };
    expect(reliability({ fuel: "Gasolina", gearbox: "Manual" }, dossier([dieselIssue])).issues).toHaveLength(0);
    expect(reliability({ fuel: "Diésel", gearbox: "Manual" }, dossier([dieselIssue])).issues).toHaveLength(1);
  });
});

// --- Risk tolerance weights ------------------------------------------------------

describe("risk tolerance", () => {
  it("gamblers weigh a great price over theoretical model risk", () => {
    const l = listing({ gearbox: "Automático", km: 100_000, priceEur: 10_900 }); // ratio ~0.78
    const d = dossier([dsgIssue]);
    const high = evaluateListing(l, criteria({ riskTolerance: "high" }), hardLimits, benchmark, d);
    const low = evaluateListing(l, criteria({ riskTolerance: "low" }), hardLimits, benchmark, d);
    expect(high.verdict.score).toBeGreaterThan(low.verdict.score);
  });
});

// --- LLM enrichment merge ---------------------------------------------------------

describe("applyEnrichment", () => {
  const enrichment = (overrides: Partial<LlmEnrichment> = {}): LlmEnrichment => ({
    summary: "Resumen honesto del anuncio.",
    factorAdjustments: {},
    redFlags: [],
    greenFlags: [],
    scamSuspicion: false,
    extraOpenQuestions: [],
    model: "test-model",
    at: "2026-07-08T12:00:00.000Z",
    ...overrides,
  });

  const baseVerdict = () => evaluateListing(listing(), criteria(), hardLimits, benchmark).verdict;

  it("clamps deltas to ±MAX_ENRICHMENT_DELTA and appends the reasons", () => {
    const before = baseVerdict();
    const after = applyEnrichment(
      before,
      enrichment({
        factorAdjustments: {
          unitEvidence: { delta: 40, reasons: ["Libro de mantenimiento citado en el anuncio"] },
          priceFairness: { delta: -40, reasons: ["Acabado base"] },
        },
      }),
    );
    expect(after.factors.unitEvidence.score - before.factors.unitEvidence.score).toBe(MAX_ENRICHMENT_DELTA);
    expect(before.factors.priceFairness.score - after.factors.priceFairness.score).toBe(MAX_ENRICHMENT_DELTA);
    expect(after.factors.unitEvidence.known).toContain("Libro de mantenimiento citado en el anuncio");
  });

  it("LLM scam suspicion caps at D and shows up as a red flag", () => {
    const after = applyEnrichment(
      baseVerdict(),
      enrichment({ scamSuspicion: true, scamReason: "pide señal por adelantado" }),
    );
    expect(after.score).toBeLessThanOrEqual(45);
    expect(after.vetoes).toContain("llm_scam_suspicion");
    expect(after.llm?.redFlags[0]).toContain("pide señal por adelantado");
  });

  it("cannot rescue a code veto: scam_price stays E under maximal positive deltas", () => {
    const scam = evaluateListing(listing({ priceEur: 7_000 }), criteria(), hardLimits, benchmark).verdict;
    const after = applyEnrichment(
      scam,
      enrichment({
        factorAdjustments: {
          priceFairness: { delta: 15, reasons: ["r"] },
          modelReliability: { delta: 15, reasons: ["r"] },
          unitEvidence: { delta: 15, reasons: ["r"] },
          sellerCredibility: { delta: 15, reasons: ["r"] },
        },
      }),
    );
    expect(after.score).toBeLessThanOrEqual(20);
    expect(after.overall).toBe("E");
  });

  it("never touches the verification axis and merges questions without duplicates", () => {
    const before = baseVerdict();
    const dupe = before.openQuestions[0]!;
    const after = applyEnrichment(
      before,
      enrichment({ extraOpenQuestions: [dupe, "¿Se puede ver un informe de ITV reciente?"] }),
    );
    expect(after.confidencePct).toBe(before.confidencePct);
    expect(after.openQuestions).toContain("¿Se puede ver un informe de ITV reciente?");
    expect(new Set(after.openQuestions).size).toBe(after.openQuestions.length);
    expect(after.openQuestions.length).toBeLessThanOrEqual(12);
  });

  it("is deterministic: same rule verdict + same enrichment → same result", () => {
    const before = baseVerdict();
    const e = enrichment({ factorAdjustments: { unitEvidence: { delta: 8, reasons: ["r"] } } });
    expect(applyEnrichment(before, e).score).toBe(applyEnrichment(before, e).score);
  });
});
