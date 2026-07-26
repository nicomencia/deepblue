import { describe, expect, it } from "vitest";
import type {
  BriefCriteria,
  HardLimits,
  LlmEnrichment,
  ModelDossier,
  NormalizedListing,
} from "./domain.js";
import type { PriceBenchmark } from "./benchmark.js";
import {
  applyEnrichment,
  evaluateListing,
  MAX_ENRICHMENT_DELTA,
  NEAR_MISS_STRETCH,
  NEGOTIATION_HEADROOM,
  scoreToGrade,
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

// --- Issue findings: seller evidence beats theory ------------------------------

describe("issue findings", () => {
  const auto = { gearbox: "Automático", km: 70_000, priceEur: 10_000 };
  const evalWith = (findings?: Parameters<typeof evaluateListing>[5]) =>
    evaluateListing(listing(auto), criteria(), hardLimits, benchmark, dossier([dsgIssue]), findings);

  it("ruled_out removes the expected cost and stops asking about it", () => {
    const base = evalWith().verdict;
    const cleared = evalWith([
      { title: dsgIssue.title, status: "ruled_out", note: "factura", at: "2026-07-12" },
    ]).verdict;
    expect(cleared.factors.modelReliability.score).toBe(95); // no cost left
    expect(cleared.factors.modelReliability.score).toBeGreaterThan(
      base.factors.modelReliability.score,
    );
    expect(cleared.issues[0]?.status).toBe("ruled_out");
    expect(cleared.openQuestions.join(" ")).not.toContain("¿Da tirones?");
    expect(base.openQuestions.join(" ")).toContain("¿Da tirones?");
  });

  it("confirmed bills the full worst-case cost", () => {
    const confirmed = evalWith([
      { title: dsgIssue.title, status: "confirmed", at: "2026-07-12" },
    ]).verdict;
    // full 2.000 € on a 10.000 € car → 95 − 50 = 45
    expect(confirmed.factors.modelReliability.score).toBe(45);
  });

  it("a confirmed critical issue vetoes the overall grade", () => {
    const critical = { ...dsgIssue, title: "Rotura de motor", severity: "critical" as const };
    const v = evaluateListing(
      listing(auto),
      criteria(),
      hardLimits,
      benchmark,
      dossier([critical]),
      [{ title: "Rotura de motor", status: "confirmed", at: "2026-07-12" }],
    ).verdict;
    expect(v.vetoes).toContain("critical_issue_confirmed");
    expect(v.score).toBeLessThanOrEqual(45);
  });

  it("resolving issues raises the confidence axis", () => {
    const base = evalWith().verdict;
    const cleared = evalWith([
      { title: dsgIssue.title, status: "ruled_out", at: "2026-07-12" },
    ]).verdict;
    expect(cleared.confidencePct).toBeGreaterThan(base.confidencePct);
  });

  it("a finding for an issue that no longer applies is ignored harmlessly", () => {
    const v = evaluateListing(
      listing({ gearbox: "Manual", km: 100_000 }),
      criteria(),
      hardLimits,
      benchmark,
      dossier([dsgIssue]),
      [{ title: dsgIssue.title, status: "confirmed", at: "2026-07-12" }],
    ).verdict;
    expect(v.issues).toHaveLength(0);
    expect(v.factors.modelReliability.score).toBe(90);
  });
});

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

  it("flags year and km violations, tolerates unknown fields", () => {
    // Just outside is a near miss (see the near-miss suite); far outside dies.
    expect(evaluateListing(listing({ year: 2014 }), criteria(), hardLimits).deadReason).toBe("year_below_minimum");
    expect(evaluateListing(listing({ year: 2020 }), criteria({ yearMax: 2019 }), hardLimits).deadReason).toBe("year_above_maximum");
    expect(evaluateListing(listing({ km: 150_000 }), criteria(), hardLimits).deadReason).toBe("km_over_limit");
    expect(evaluateListing(listing({ year: 2010 }), criteria(), hardLimits).outcome).toBe("dead");
    expect(evaluateListing(listing({ km: 400_000 }), criteria(), hardLimits).outcome).toBe("dead");
    expect(evaluateListing(listing({ year: undefined, km: undefined }), criteria(), hardLimits).outcome).toBe("shortlisted");
  });

  it("enforces the search radius in code — Wallapop ignores distance params", () => {
    const madrid = { location: { lat: 40.4168, lon: -3.7038, radiusKm: 100 } };
    // Zaragoza is ~274 km from Madrid: outside a 100 km hunt.
    const zaragoza = { lat: 41.6488, lon: -0.8891 };
    expect(
      evaluateListing(listing(zaragoza), criteria(madrid), hardLimits).deadReason,
    ).toBe("outside_search_radius");
    // Toledo (~67 km) fits; missing coordinates never condemn.
    expect(
      evaluateListing(listing({ lat: 39.8628, lon: -4.0273 }), criteria(madrid), hardLimits).outcome,
    ).toBe("shortlisted");
    expect(
      evaluateListing(listing({ lat: undefined, lon: undefined }), criteria(madrid), hardLimits).outcome,
    ).toBe("shortlisted");
    // Slack absorbs city-centroid pins just over the line (radius + 15 km).
    expect(
      evaluateListing(listing({ lat: 41.3, lon: -3.7 }), criteria(madrid), hardLimits).outcome,
    ).toBe("shortlisted"); // ~98 km
  });

  it("keeps asking prices within negotiation headroom, drops them above it", () => {
    const cap = Math.round(hardLimits.maxPriceEur * NEGOTIATION_HEADROOM); // 17.825
    expect(evaluateListing(listing({ priceEur: cap }), criteria(), hardLimits).outcome).toBe("shortlisted");
    const over = evaluateListing(listing({ priceEur: cap + 1 }), criteria(), hardLimits);
    expect(over.outcome).not.toBe("shortlisted");
    expect(over.deadReason).toBe("price_over_budget");
    // Far above the headroom is dead, not a near miss.
    expect(evaluateListing(listing({ priceEur: cap * 2 }), criteria(), hardLimits).outcome).toBe("dead");
  });

  it("budget-checks the real cash price, not the financing headline", () => {
    const r = evaluateListing(
      listing({ priceEur: 15_000, cashPriceEur: 18_500 }),
      criteria(),
      hardLimits,
    );
    expect(r.outcome).not.toBe("shortlisted");
    expect(r.deadReason).toBe("price_over_budget");
  });
});

// --- Near misses: elastic limits stretch, absolute ones never do --------------

describe("near misses", () => {
  it("keeps a unit just over an elastic limit, with the overshoot measured", () => {
    // kmMax 140.000; the band reaches 161.000.
    const r = evaluateListing(listing({ km: 150_000 }), criteria(), hardLimits);
    expect(r.outcome).toBe("near_miss");
    expect(r.nearMiss).toMatchObject({ reason: "km_over_limit", limit: 140_000, actual: 150_000 });
    expect(r.nearMiss?.overshoot).toBeCloseTo(0.0714, 3);
  });

  it("kills the same limit once it is past the band", () => {
    const edge = Math.floor(140_000 * NEAR_MISS_STRETCH); // 161.000
    expect(evaluateListing(listing({ km: edge }), criteria(), hardLimits).outcome).toBe("near_miss");
    expect(evaluateListing(listing({ km: edge + 1_000 }), criteria(), hardLimits).outcome).toBe("dead");
  });

  it("stretches years by whole years, not by a ratio", () => {
    const oneBelow = evaluateListing(listing({ year: 2014 }), criteria(), hardLimits);
    expect(oneBelow.outcome).toBe("near_miss");
    expect(oneBelow.nearMiss?.reason).toBe("year_below_minimum");
    // Two years below is outside the slack — a ratio would have kept it.
    expect(evaluateListing(listing({ year: 2013 }), criteria(), hardLimits).outcome).toBe("dead");
  });

  it("stretches the budget beyond the negotiation headroom", () => {
    const cap = hardLimits.maxPriceEur * NEGOTIATION_HEADROOM;
    expect(evaluateListing(listing({ priceEur: Math.round(cap * 1.1) }), criteria(), hardLimits).outcome)
      .toBe("near_miss");
    expect(evaluateListing(listing({ priceEur: Math.round(cap * 1.2) }), criteria(), hardLimits).outcome)
      .toBe("dead");
  });

  it("never stretches an absolute limit — a wrong vehicle or an import is a no", () => {
    const wrong = evaluateListing(
      listing({ title: "Seat León FR", make: "Seat", model: "León" }),
      criteria(),
      hardLimits,
    );
    expect(wrong.outcome).toBe("dead");
    expect(wrong.nearMiss).toBeUndefined();

    const rhd = evaluateListing(
      listing({ title: "Volkswagen Golf 1.4 TSI volante a la derecha", rhd: true }),
      criteria(),
      { ...hardLimits, noRhd: true },
    );
    expect(rhd.outcome).toBe("dead");
    expect(rhd.deadReason).toBe("rhd_not_accepted");
    expect(rhd.nearMiss).toBeUndefined();
  });

  it("an absolute limit wins over an elastic one on the same listing", () => {
    // Over km AND the wrong vehicle: it must die, never surface as a near miss.
    const r = evaluateListing(
      listing({ title: "Seat León FR", make: "Seat", model: "León", km: 150_000 }),
      criteria(),
      hardLimits,
    );
    expect(r.outcome).toBe("dead");
    expect(r.deadReason).toBe("different_vehicle");
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

// --- Import signals: RHD and foreign plates hit the price factor ---------------

describe("import signals", () => {
  it("penalizes RHD against an otherwise identical listing", () => {
    const base = evaluateListing(listing(), criteria(), hardLimits, benchmark);
    const rhd = evaluateListing(
      listing({ title: "Volkswagen Golf 1.4 TSI RHD" }),
      criteria(),
      hardLimits,
      benchmark,
    );
    expect(rhd.verdict.factors.priceFairness.score).toBeLessThan(
      base.verdict.factors.priceFairness.score,
    );
    expect(rhd.verdict.openQuestions.join(" ")).toMatch(/matriculado en España/i);
  });

  it("compares foreign-plated cars with the re-registration cost added", () => {
    const base = evaluateListing(listing(), criteria(), hardLimits, benchmark);
    const foreign = evaluateListing(
      listing({ description: "Coche con matrícula inglesa, perfecto estado" }),
      criteria(),
      hardLimits,
      benchmark,
    );
    expect(foreign.verdict.factors.priceFairness.score).toBeLessThan(
      base.verdict.factors.priceFairness.score,
    );
    expect(foreign.verdict.openQuestions[0]).toMatch(/rematriculación/i);
  });

  it("does not penalize an import already on Spanish plates", () => {
    const base = evaluateListing(listing(), criteria(), hardLimits, benchmark);
    const nationalized = evaluateListing(
      listing({ description: "Importado de Alemania, ya matriculado en España" }),
      criteria(),
      hardLimits,
      benchmark,
    );
    expect(nationalized.verdict.factors.priceFairness.score).toBe(
      base.verdict.factors.priceFairness.score,
    );
  });
});

// --- Verified import facts and hard limits -------------------------------------

describe("import facts and hard limits", () => {
  const ukAd = listing({ description: "Vehiculo con papeles y matricula inglesa." });

  it("a verified listing flag beats text inference in both directions", () => {
    // Seller confirmed LHD: the UK-origin assumption must not penalize.
    const lhdVerified = evaluateListing(
      { ...ukAd, rhd: false },
      criteria(),
      hardLimits,
      benchmark,
    );
    const assumed = evaluateListing(ukAd, criteria(), hardLimits, benchmark);
    expect(lhdVerified.verdict.factors.priceFairness.score).toBeGreaterThan(
      assumed.verdict.factors.priceFairness.score,
    );

    // User verified RHD from the photos on an ad whose text says nothing.
    const marked = evaluateListing(
      listing({ rhd: true }),
      criteria(),
      hardLimits,
      benchmark,
    );
    const plain = evaluateListing(listing(), criteria(), hardLimits, benchmark);
    expect(marked.verdict.factors.priceFairness.score).toBeLessThan(
      plain.verdict.factors.priceFairness.score,
    );
  });

  it("noRhd kills confirmed RHD but never the assumption alone", () => {
    const noRhd = { ...hardLimits, noRhd: true };
    expect(
      evaluateListing(listing({ rhd: true }), criteria(), noRhd, benchmark).deadReason,
    ).toBe("rhd_not_accepted");
    expect(
      evaluateListing(listing({ title: "Golf RHD" }), criteria(), noRhd, benchmark).deadReason,
    ).toBe("rhd_not_accepted");
    // UK plates without stated wheel side: assumed RHD stays alive (question pending).
    expect(evaluateListing(ukAd, criteria(), noRhd, benchmark).outcome).toBe("shortlisted");
  });

  it("requireSpanishPlates kills foreign-plated cars", () => {
    const esOnly = { ...hardLimits, requireSpanishPlates: true };
    expect(evaluateListing(ukAd, criteria(), esOnly, benchmark).deadReason).toBe(
      "foreign_plates_not_accepted",
    );
    expect(
      evaluateListing(listing({ foreignPlates: true }), criteria(), esOnly, benchmark).deadReason,
    ).toBe("foreign_plates_not_accepted");
    expect(evaluateListing(listing(), criteria(), esOnly, benchmark).outcome).toBe("shortlisted");
  });
});
