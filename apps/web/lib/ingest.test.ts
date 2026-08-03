import type {
  ConfidenceVerdict,
  EvaluationResult,
  NearMiss,
  NormalizedListing,
} from "@deepblue/core";
import { describe, expect, it } from "vitest";
import { composeAlert, composeAlertHtml } from "./alerts";
import { describeMiss } from "./ingest";

const verdict = (over: Partial<ConfidenceVerdict>): ConfidenceVerdict =>
  ({
    overall: "B",
    score: 78,
    confidencePct: 65,
    openQuestions: ["¿Tiene el libro de mantenimiento al día?"],
    ...over,
  }) as ConfidenceVerdict;

const item = {
  platform: "wallapop",
  platformListingId: "abc123",
  url: "https://es.wallapop.com/item/abc123",
  title: "Volkswagen Golf 2018",
  priceEur: 13499,
  year: 2018,
  km: 67000,
  locationText: "Madrid",
} as NormalizedListing;

const evaluation = (v: ConfidenceVerdict): EvaluationResult =>
  ({ outcome: "shortlisted", verdict: v }) as EvaluationResult;

describe("composeAlert", () => {
  it("is the lead's brief: title, specs, grade and the triage line", () => {
    const text = composeAlert(item, evaluation(verdict({})), "lead-1");
    expect(text).toContain("Volkswagen Golf 2018");
    expect(text).toContain("13.499 €");
    expect(text).toContain("Confianza global: B");
    expect(text).toContain("Recomendación:");
    expect(text).toContain("merece escribir al vendedor");
  });

  it("never carries the question list (user rule 2026-07-17)", () => {
    const text = composeAlert(item, evaluation(verdict({})), "lead-1");
    expect(text).not.toContain("Preguntas clave");
    expect(text).not.toContain("libro de mantenimiento");
  });

  it("shows exposure and budget note when the verdict has them", () => {
    const text = composeAlert(
      item,
      evaluation(
        verdict({
          repairExposureEur: { min: 2150, max: 4950 },
          budgetNote: "Peor caso ~4.950 € → dentro de tu presupuesto",
        }),
      ),
    );
    expect(text).toContain("2150–4950 €");
    expect(text).toContain("dentro de tu presupuesto");
  });
});

describe("describeMiss", () => {
  const miss = (over: Partial<NearMiss>): NearMiss => ({
    reason: "km_over_limit",
    limit: 180_000,
    actual: 195_000,
    overshoot: 15_000 / 180_000,
    ...over,
  });

  it("says which limit was missed and by how much, in the user's units", () => {
    expect(describeMiss(miss({}))).toBe(
      "195.000 km, 8% por encima de tu tope de 180.000 km",
    );
  });

  it("frames a year miss in whole years, never a percentage", () => {
    const text = describeMiss(
      miss({ reason: "year_below_minimum", limit: 2005, actual: 2004, overshoot: 1 / 2005 }),
    );
    expect(text).toBe("del 2004, un año por debajo de tu mínimo (2005)");
    expect(text).not.toContain("%");
  });

  it("rounds distance to whole km rather than leaking haversine decimals", () => {
    expect(
      describeMiss({
        reason: "outside_search_radius",
        limit: 215,
        actual: 231.47829,
        overshoot: 16.47829 / 215,
      }),
    ).toBe("a 231 km, 8% más lejos de tu radio de 215 km");
  });

  it("degrades to the raw reason rather than throwing on an unknown limit", () => {
    expect(describeMiss(miss({ reason: "some_future_limit" }))).toContain("some_future_limit");
  });
});

describe("composeAlertHtml", () => {
  it("links the lead page and escapes the triage line", () => {
    const html = composeAlertHtml(item, evaluation(verdict({})), "lead-1");
    expect(html).toContain("lead-1");
    expect(html).toContain("<strong>B</strong>");
    expect(html).toContain("merece escribir al vendedor");
    expect(html).not.toContain("libro de mantenimiento");
  });
});
