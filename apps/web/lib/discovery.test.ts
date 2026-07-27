import type { DiscoveryProfile, ModelRecommendation } from "@deepblue/core";
import { describe, expect, it } from "vitest";
import { briefNameForRecommendation, recommendationToBrief } from "./discovery";

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
