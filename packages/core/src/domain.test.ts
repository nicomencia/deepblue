import { describe, expect, it } from "vitest";
import {
  ACTIVE_PLATFORMS,
  canTransition,
  isPlatformActive,
  llmEnrichmentPayloadSchema,
  modelDossierSchema,
  normalizedListingSchema,
  PLATFORMS,
} from "./domain.js";

describe("active platforms", () => {
  it("is Wallapop-only right now (AutoScout24 paused)", () => {
    expect([...ACTIVE_PLATFORMS]).toEqual(["wallapop"]);
    expect(isPlatformActive("wallapop")).toBe(true);
    expect(isPlatformActive("autoscout24")).toBe(false);
  });

  it("only ever contains real platforms", () => {
    for (const p of ACTIVE_PLATFORMS) expect(PLATFORMS).toContain(p);
  });
});

describe("lead state machine", () => {
  it("walks the happy path one stage at a time", () => {
    expect(canTransition("discovered", "evaluated")).toBe(true);
    expect(canTransition("evaluated", "shortlisted")).toBe(true);
    expect(canTransition("shortlisted", "contacted")).toBe(true);
    expect(canTransition("contacted", "negotiating")).toBe(true);
    expect(canTransition("negotiating", "agreement")).toBe(true);
    expect(canTransition("agreement", "visit_proposed")).toBe(true);
    expect(canTransition("visit_proposed", "handed_off")).toBe(true);
  });

  it("never skips forward past an unvisited stage", () => {
    expect(canTransition("discovered", "shortlisted")).toBe(false);
    expect(canTransition("evaluated", "negotiating")).toBe(false);
    expect(canTransition("shortlisted", "agreement")).toBe(false);
  });

  it("everything may die except terminal states", () => {
    expect(canTransition("evaluated", "dead")).toBe(true);
    expect(canTransition("negotiating", "dead")).toBe(true);
    expect(canTransition("handed_off", "dead")).toBe(false);
    expect(canTransition("dead", "evaluated")).toBe(false);
  });

  it("a failed visit can reopen negotiation", () => {
    expect(canTransition("visit_proposed", "negotiating")).toBe(true);
  });
});

describe("LLM trust-boundary schemas", () => {
  const validIssue = {
    title: "DSG mecatrónica",
    description: "Fallos típicos del DQ200",
    applicability: { gearbox: "automatic", kmMin: 60_000 },
    typicalRepairCostEur: { min: 1_500, max: 2_500 },
    evidence: ["Factura de aceite DSG"],
    sellerQuestions: ["¿Da tirones?"],
    severity: "major",
    sources: ["https://example.com/dsg"],
  };

  it("accepts a well-formed dossier", () => {
    const dossier = {
      make: "Volkswagen",
      model: "Golf",
      generation: "VII (2012–2019)",
      knownIssues: [validIssue],
      recalls: [{ title: "Campaña correa", year: 2015, source: "https://example.com" }],
      generalNotes: [],
      sources: ["https://example.com"],
    };
    expect(modelDossierSchema.parse(dossier).knownIssues).toHaveLength(1);
  });

  it("rejects a dossier issue with an unknown severity or missing sources", () => {
    const bad = { ...validIssue, severity: "catastrophic" };
    expect(modelDossierSchema.safeParse({
      make: "VW", model: "Golf", knownIssues: [bad], recalls: [], generalNotes: [], sources: [],
    }).success).toBe(false);

    const { sources: _sources, ...noSources } = validIssue;
    expect(modelDossierSchema.safeParse({
      make: "VW", model: "Golf", knownIssues: [noSources], recalls: [], generalNotes: [], sources: [],
    }).success).toBe(false);
  });

  it("accepts a minimal enrichment payload and rejects a delta-less adjustment", () => {
    const minimal = {
      summary: "Anuncio de plantilla sin datos de la unidad.",
      factorAdjustments: {},
      redFlags: [],
      greenFlags: [],
      scamSuspicion: false,
      extraOpenQuestions: [],
    };
    expect(llmEnrichmentPayloadSchema.parse(minimal).scamSuspicion).toBe(false);

    const bad = { ...minimal, factorAdjustments: { priceFairness: { reasons: ["sin delta"] } } };
    expect(llmEnrichmentPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("normalizedListingSchema keeps the Runner→Core boundary strict on platform", () => {
    expect(
      normalizedListingSchema.safeParse({
        platform: "milanuncios",
        platformListingId: "1",
        url: "https://x",
        title: "Golf",
        raw: {},
      }).success,
    ).toBe(false);
  });
});
