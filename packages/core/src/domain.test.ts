import { describe, expect, it } from "vitest";
import { conversationReadingPayloadSchema } from "./domain.js";
import {
  ACTIVE_PLATFORMS,
  canTransition,
  discoveryReportSchema,
  dossierCoversModel,
  dossierCoversYears,
  generationYearSpan,
  gradeAtMost,
  isPlatformActive,
  llmEnrichmentPayloadSchema,
  modelDossierSchema,
  normalizedListingSchema,
  pickDossierForYear,
  PLATFORMS,
  sameModelFamily,
  type ModelDossier,
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

describe("dossierCoversModel", () => {
  it("matches exact and word-prefix models, case-insensitively", () => {
    expect(dossierCoversModel("207", "207")).toBe(true);
    expect(dossierCoversModel("207", "207 rc")).toBe(true);
    expect(dossierCoversModel("Golf", "golf GTI")).toBe(true);
    expect(dossierCoversModel("207", "2072")).toBe(false); // no partial-token match
    expect(dossierCoversModel("207 rc", "207")).toBe(false); // prefix is one-way
  });
});

describe("sameModelFamily", () => {
  it("is symmetric where dossier coverage is one-way", () => {
    expect(sameModelFamily("207", "207 rc")).toBe(true);
    expect(sameModelFamily("207 rc", "207")).toBe(true);
    expect(sameModelFamily("golf", "golf")).toBe(true);
    expect(sameModelFamily("207", "208")).toBe(false);
    expect(sameModelFamily("serie 3", "serie 5")).toBe(false);
  });
});

describe("generationYearSpan", () => {
  it("parses closed and open-ended spans from generation labels", () => {
    expect(generationYearSpan("I (1980–1997)")).toEqual({ yearMin: 1980, yearMax: 1997 });
    expect(generationYearSpan("VII (2012-2019)")).toEqual({ yearMin: 2012, yearMax: 2019 });
    expect(generationYearSpan("III (2010–presente)")).toEqual({ yearMin: 2010, yearMax: undefined });
    expect(generationYearSpan("Mk2 (1998–actualidad)")).toEqual({ yearMin: 1998, yearMax: undefined });
  });

  it("returns undefined when there is nothing parseable", () => {
    expect(generationYearSpan(undefined)).toBeUndefined();
    expect(generationYearSpan("VII")).toBeUndefined();
    expect(generationYearSpan("Fase 2")).toBeUndefined();
  });
});

describe("dossierCoversYears", () => {
  it("a generation span only covers hunt windows it overlaps", () => {
    // Gen-III dossier (2010–presente) vs a gen-I hunt capped at 1997: no cover.
    expect(dossierCoversYears("III (2010–presente)", undefined, 1997)).toBe(false);
    expect(dossierCoversYears("III (2010–presente)", 2012, undefined)).toBe(true);
    // Gen-I dossier vs a modern hunt: no cover the other way round.
    expect(dossierCoversYears("I (1980–1997)", 2010, undefined)).toBe(false);
    expect(dossierCoversYears("I (1980–1997)", 1985, 1995)).toBe(true);
    // Partial overlap counts as cover.
    expect(dossierCoversYears("II (1998–2010)", 2005, 2015)).toBe(true);
  });

  it("span-less labels are universal; open windows never exclude", () => {
    expect(dossierCoversYears(undefined, 1980, 1997)).toBe(true);
    expect(dossierCoversYears("VII", 1980, 1997)).toBe(true);
    expect(dossierCoversYears("I (1980–1997)", undefined, undefined)).toBe(true);
  });
});

describe("pickDossierForYear", () => {
  const dossier = (generation?: string): ModelDossier => ({
    make: "Renault",
    model: "Master",
    ...(generation ? { generation } : {}),
    knownIssues: [],
    recalls: [],
    generalNotes: [],
    sources: [],
  });

  it("a listing year selects the generation whose span covers it", () => {
    const genIII = dossier("III (2010–presente)");
    const genI = dossier("I (1980–1997)");
    expect(pickDossierForYear([genIII, genI], 1990)).toBe(genI);
    expect(pickDossierForYear([genIII, genI], 2015)).toBe(genIII);
  });

  it("a span that excludes the year is never applied — span-less wins as universal", () => {
    const genIII = dossier("III (2010–presente)");
    const universal = dossier(); // no generation label → applies to all years
    expect(pickDossierForYear([genIII, universal], 1990)).toBe(universal);
    // Only the wrong generation exists → honestly no dossier at all.
    expect(pickDossierForYear([genIII], 1990)).toBeUndefined();
  });

  it("without a year, the pre-ordered first candidate wins (old behavior)", () => {
    const genIII = dossier("III (2010–presente)");
    const genI = dossier("I (1980–1997)");
    expect(pickDossierForYear([genIII, genI], undefined)).toBe(genIII);
    expect(pickDossierForYear([], undefined)).toBeUndefined();
  });
});

describe("gradeAtMost", () => {
  it("accepts grades at or above the threshold (A is best)", () => {
    expect(gradeAtMost("A", "C")).toBe(true);
    expect(gradeAtMost("C", "C")).toBe(true);
    expect(gradeAtMost("D", "C")).toBe(false);
    expect(gradeAtMost("E", "C")).toBe(false);
  });

  it("a strict threshold only lets the top grade through", () => {
    expect(gradeAtMost("A", "A")).toBe(true);
    expect(gradeAtMost("B", "A")).toBe(false);
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

  it("conversationReadingPayloadSchema validates a full reading and rejects bad bases", () => {
    const reading = {
      summary: "El vendedor confirma libro de mantenimiento y matrícula UK.",
      factorAdjustments: {
        sellerCredibility: { delta: 4, reasons: ["Responde rápido y con datos concretos"] },
      },
      redFlags: [],
      greenFlags: ["Dice tener todas las facturas"],
      scamSuspicion: false,
      extraOpenQuestions: [],
      issueUpdates: [
        {
          title: "Rodamiento IMS",
          status: "ruled_out",
          basis: "evidence_shared",
          quote: "te paso la factura del cambio de IMS",
        },
      ],
      importFacts: { foreignPlates: true, quote: "tiene contrato de compra venta + el V5" },
      escalate: false,
    };
    expect(conversationReadingPayloadSchema.parse(reading).issueUpdates).toHaveLength(1);

    const bad = {
      ...reading,
      issueUpdates: [{ ...reading.issueUpdates[0], basis: "trust_me" }],
    };
    expect(conversationReadingPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("discoveryReportSchema demands 1–5 concrete recommendations", () => {
    const rec = {
      make: "Toyota",
      model: "GT86",
      versions: ["2.0 200 CV"],
      avoidVersions: [],
      priceBandEur: { min: 14_000, max: 19_000 },
      whyFits: ["Atmosférico fiable y divertido"],
      watchouts: ["Muelles de válvula (recall 2019)"],
      sources: ["https://example.com"],
    };
    const report = { headline: "Perfil de findes.", recommendations: [rec], discarded: [], sources: [] };
    expect(discoveryReportSchema.parse(report).recommendations).toHaveLength(1);
    expect(
      discoveryReportSchema.safeParse({ ...report, recommendations: [] }).success,
    ).toBe(false);
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
