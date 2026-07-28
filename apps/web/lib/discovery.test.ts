import type { DiscoveryProfile, DiscoveryReport, ModelRecommendation } from "@deepblue/core";
import { describe, expect, it } from "vitest";
import { briefNameForRecommendation, recommendationToBrief, thinRecommendations } from "./discovery";

const profile = (over: Partial<DiscoveryProfile> = {}): DiscoveryProfile => ({
  budgetEur: 9000,
  usage: "ciudad + findes",
  priorities: [],
  mustHaves: [],
  dealBreakers: [],
  ...over,
});

const rec = (over: Partial<ModelRecommendation> = {}): ModelRecommendation => ({
  make: "Toyota",
  model: "Yaris",
  generation: "XP130",
  versions: ["1.33 Dual VVT-i"],
  avoidVersions: [],
  yearMin: 2011,
  yearMax: 2014,
  priceBandEur: { min: 4000, max: 6500 },
  whyFits: [],
  watchouts: [],
  sources: [],
  ...over,
});

describe("recommendationToBrief", () => {
  it("intersects the year bands instead of letting one win", () => {
    // The recommendation proposes a generation; the user says what they will
    // actually buy. Taking either alone hunts outside the generation or
    // ignores the user.
    const brief = recommendationToBrief(profile({ yearMin: 2013, yearMax: 2020 }), rec());
    expect(brief.criteria.yearMin).toBe(2013); // user is stricter
    expect(brief.criteria.yearMax).toBe(2014); // generation is stricter
  });

  it("falls back to whichever band exists", () => {
    expect(recommendationToBrief(profile(), rec()).criteria.yearMin).toBe(2011);
    expect(
      recommendationToBrief(profile({ yearMin: 2012 }), rec({ yearMin: undefined })).criteria.yearMin,
    ).toBe(2012);
    expect(
      recommendationToBrief(profile(), rec({ yearMin: undefined, yearMax: undefined })).criteria
        .yearMin,
    ).toBeUndefined();
  });

  it("carries the user's own limits into the brief", () => {
    const brief = recommendationToBrief(
      profile({ kmMax: 150_000, noRhd: true, requireSpanishPlates: true, ecoLabelMin: "C" }),
      rec(),
    );
    expect(brief.criteria.kmMax).toBe(150_000);
    expect(brief.hardLimits.noRhd).toBe(true);
    expect(brief.hardLimits.requireSpanishPlates).toBe(true);
    // No ecoLabel field on BriefCriteria yet: it must survive as a stated
    // condition rather than being dropped between profile and brief.
    expect(brief.criteria.notes).toContain("Etiqueta DGT mínima: C");
  });

  it("leaves unstated limits unset rather than asserting a false negative", () => {
    const brief = recommendationToBrief(profile(), rec());
    expect(brief.criteria.kmMax).toBeUndefined();
    expect(brief.hardLimits.noRhd).toBeUndefined();
    expect(brief.hardLimits.requireSpanishPlates).toBeUndefined();
  });

  it("defaults to all of Spain — no location means no radius check at all", () => {
    // Wallapop ignores distance params and returns country-wide results, so
    // the radius only ever existed as an evaluation filter. The old hardcoded
    // Madrid ±200 km silently narrowed every discovery hunt to a third of the
    // country; absent is the honest way to say "anywhere".
    expect(recommendationToBrief(profile(), rec()).criteria.location).toBeUndefined();

    const local = recommendationToBrief(
      profile({ location: { lat: 41.3874, lon: 2.1686, radiusKm: 75 } }),
      rec(),
    );
    expect(local.criteria.location).toEqual({ lat: 41.3874, lon: 2.1686, radiusKm: 75 });
  });

  it("carries risk and seller preference, keeping the old defaults when unset", () => {
    const stated = recommendationToBrief(
      profile({ riskTolerance: "low", sellerPreference: "any" }),
      rec(),
    );
    expect(stated.criteria.riskTolerance).toBe("low");
    expect(stated.criteria.sellerPreference).toBe("any");

    const unstated = recommendationToBrief(profile(), rec());
    expect(unstated.criteria.riskTolerance).toBe("medium");
    expect(unstated.criteria.sellerPreference).toBe("prefer_private");
  });

  it("caps the price by the tighter of budget and price band", () => {
    expect(recommendationToBrief(profile({ budgetEur: 5000 }), rec()).hardLimits.maxPriceEur).toBe(5000);
    expect(recommendationToBrief(profile({ budgetEur: 9000 }), rec()).hardLimits.maxPriceEur).toBe(6500);
  });

  it("names the brief with the generation so two generations do not collide", () => {
    expect(briefNameForRecommendation(rec())).toBe("Descubrimiento: Toyota Yaris (XP130)");
    expect(briefNameForRecommendation(rec({ generation: "XP90" }))).toBe(
      "Descubrimiento: Toyota Yaris (XP90)",
    );
    expect(briefNameForRecommendation(rec({ generation: undefined }))).toBe(
      "Descubrimiento: Toyota Yaris",
    );
  });
});

describe("thinRecommendations", () => {
  const full = () =>
    rec({
      versions: ["1.0 VVT-i", "1.33 Dual VVT-i"],
      avoidVersions: ["MultiMode: tirones", "1.4 D-4D: FAP en ciudad"],
      whyFits: ["fiabilidad", "consumo", "tamaño", "etiqueta C"],
      watchouts: ["EPS", "airbag", "ruido", "km de flota"],
    });

  const report = (recs: ModelRecommendation[]): DiscoveryReport => ({
    headline: "h",
    recommendations: recs,
    discarded: [],
    sources: [],
  });

  it("counts a report that meets the asked-for depth as fine", () => {
    expect(thinRecommendations(report([full(), full()]))).toBe(0);
  });

  it("flags the shortfall that made reports read worse over time", () => {
    // The real regression on 27/07: same model, same per-line quality, but
    // whyFits/watchouts came back at 3 instead of 4.
    const shallow = rec({
      ...full(),
      whyFits: ["fiabilidad", "consumo", "tamaño"],
      watchouts: ["EPS", "airbag", "ruido"],
    });
    expect(thinRecommendations(report([full(), shallow]))).toBe(1);
  });

  it("does not punish a recommendation that goes deeper than asked", () => {
    const deep = rec({ ...full(), whyFits: [...full().whyFits, "extra", "otra más"] });
    expect(thinRecommendations(report([deep]))).toBe(0);
  });
});

describe("DEPTH rebalance", () => {
  // The screen exists to help choose BETWEEN models. whyFits is the only
  // field that answers that; the rest are handoffs to the brief and dossier.
  it("keeps whyFits the deepest field", () => {
    const thin = rec({
      versions: ["1.0 VVT-i", "1.33"],
      avoidVersions: ["MultiMode"],
      whyFits: ["a", "b", "c"], // one short of the floor
      watchouts: ["EPS", "airbag", "ruido"],
    });
    const report: DiscoveryReport = {
      headline: "h",
      recommendations: [thin],
      discarded: [],
      sources: [],
    };
    expect(thinRecommendations(report)).toBe(1);
  });

  it("accepts the trimmed handoff sections", () => {
    const trimmed = rec({
      versions: ["1.0 VVT-i 69 CV manual", "1.33 Dual VVT-i 99 CV manual"],
      avoidVersions: ["MultiMode: tirones"],
      whyFits: ["a", "b", "c", "d"],
      watchouts: ["EPS", "airbag", "km de flota"],
    });
    const report: DiscoveryReport = {
      headline: "h",
      recommendations: [trimmed],
      discarded: [],
      sources: [],
    };
    expect(thinRecommendations(report)).toBe(0);
  });
});
