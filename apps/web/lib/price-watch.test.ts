import type { ConfidenceVerdict } from "@deepblue/core";
import { describe, expect, it } from "vitest";
import { composePriceDropEmail } from "./price-watch";

const verdict = {
  overall: "B",
  score: 79,
  confidencePct: 65,
  openQuestions: [],
} as unknown as ConfidenceVerdict;

describe("composePriceDropEmail", () => {
  const mail = composePriceDropEmail({
    title: "Volkswagen Golf 2018",
    oldPriceEur: 13990,
    newPriceEur: 12990,
    verdict,
    leadId: "lead-1",
  });

  it("headlines the drop amount", () => {
    expect(mail.subject).toContain("bajada de precio");
    expect(mail.subject).toContain("−1000 €");
    expect(mail.subject).toContain("Volkswagen Golf 2018");
  });

  it("shows old → new with the percentage and the triage line", () => {
    expect(mail.text).toContain("13.990 € → 12.990 €");
    expect(mail.text).toContain("(−7%)");
    expect(mail.text).toContain("Recomendación:");
    expect(mail.text).toContain("merece escribir al vendedor");
    expect(mail.text).toContain("lead-1");
  });
});
