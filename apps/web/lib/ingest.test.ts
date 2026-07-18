import type { ConfidenceVerdict, EvaluationResult, NormalizedListing } from "@deepblue/core";
import { describe, expect, it } from "vitest";
import { composeAlert, composeAlertHtml } from "./ingest";

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

describe("composeAlertHtml", () => {
  it("links the lead page and escapes the triage line", () => {
    const html = composeAlertHtml(item, evaluation(verdict({})), "lead-1");
    expect(html).toContain("lead-1");
    expect(html).toContain("<strong>B</strong>");
    expect(html).toContain("merece escribir al vendedor");
    expect(html).not.toContain("libro de mantenimiento");
  });
});
