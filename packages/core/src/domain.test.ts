import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conversationReadingPayloadSchema } from "./domain.js";
import {
  ACTIVE_PLATFORMS,
  canTransition,
  discoveryReportSchema,
  discoveryResearchSchema,
  normalizeBodyStyle,
  normalizeDrivetrain,
  dossierCoversModel,
  dossierCoversYears,
  generationYearSpan,
  gradeAtMost,
  isPlatformActive,
  llmEnrichmentPayloadSchema,
  normalizeImageUrl,
  parseDiscoveryReport,
  splitModelAndGeneration,
  modelDossierSchema,
  normalizedListingSchema,
  pickDossierForYear,
  PLATFORMS,
  sameModelFamily,
  sameModelName,
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

describe("sameModelName", () => {
  // Two briefs one letter apart each paid for their own dossier (2026-07-29).
  it("forgives spelling inside a name of the same length", () => {
    expect(sameModelName("Sport Spider", "Sports Spider")).toBe(true);
    expect(sameModelName("Sports Spider", "Sport Spider")).toBe(true);
    expect(sameModelName("GR Yaris", "gr yaris")).toBe(true);
    expect(sameModelName("Serie 3", "serie-3")).toBe(true);
  });

  // The whole point of the token-count rule: an extra word is how a maker
  // names a DIFFERENT car, and merging these would hide a real dossier.
  it("never fuses a model with its hotter sibling", () => {
    expect(sameModelName("Golf", "Golf R")).toBe(false);
    expect(sameModelName("207", "207 RC")).toBe(false);
    expect(sameModelName("Yaris", "GR Yaris")).toBe(false);
    expect(sameModelName("RAV4", "RAV4 Adventure")).toBe(false);
  });

  it("keeps genuinely different models apart", () => {
    expect(sameModelName("207", "208")).toBe(false);
    expect(sameModelName("Serie 3", "Serie 5")).toBe(false);
    expect(sameModelName("Clio", "Captur")).toBe(false);
  });

  it("does not shrink a short token to a stub", () => {
    // "RS" must not become "R", or RS3 and R3 would read alike.
    expect(sameModelName("RS 3", "R 3")).toBe(false);
    expect(sameModelName("", "")).toBe(false);
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

  it("splits the generation out of the model, because the model is the search keyword", () => {
    // The real 2026-07-27 report: every model carried its generation, the
    // sweep searched "Toyota Yaris (XP90, 2006-2011)" and found nothing.
    expect(splitModelAndGeneration("Yaris (XP90, 2006-2011)")).toEqual({
      model: "Yaris",
      generation: "XP90",
    });
    expect(splitModelAndGeneration("Jazz (GE, 2ª generación, 2008-2015)")).toEqual({
      model: "Jazz",
      generation: "GE",
    });
    expect(splitModelAndGeneration("Mazda2 (DE, 2007-2014)")).toEqual({
      model: "Mazda2",
      generation: "DE",
    });
    // Only year ranges inside: nothing that identifies a generation.
    expect(splitModelAndGeneration("Swift (2005-2010 / 2010-2017)")).toEqual({
      model: "Swift",
      generation: undefined,
    });
    // Already clean, and a model that is nothing but a parenthetical.
    expect(splitModelAndGeneration("Golf")).toEqual({ model: "Golf", generation: undefined });
    expect(splitModelAndGeneration("(XP130)").model).toBe("(XP130)");
  });

  it("turns a Wikimedia description page into a file URL and drops non-images", () => {
    expect(normalizeImageUrl("https://commons.wikimedia.org/wiki/File:Yaris_(XP90).jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Yaris_(XP90).jpg?width=640",
    );
    // Spanish-language file namespace, non-commons wiki host.
    expect(normalizeImageUrl("https://es.wikipedia.org/wiki/Archivo:Mazda2.JPG")).toBe(
      "https://es.wikipedia.org/wiki/Special:FilePath/Mazda2.JPG?width=640",
    );
    // Already a direct file: left alone.
    expect(normalizeImageUrl("https://upload.wikimedia.org/x/Yaris.jpg")).toBe(
      "https://upload.wikimedia.org/x/Yaris.jpg",
    );
    // An article, a search page, nothing: no photo beats a broken photo.
    expect(normalizeImageUrl("https://es.wikipedia.org/wiki/Toyota_Yaris")).toBeUndefined();
    expect(normalizeImageUrl(undefined)).toBeUndefined();
  });

  it("keeps the LLM-facing schemas convertible to JSON Schema", () => {
    // These are handed to the SDK as the structured-output format. A
    // `.transform()` anywhere inside makes zodOutputFormat throw at request
    // time — invisible to typecheck and to every other test, and it takes the
    // whole feature down (shipped and caught live 2026-07-27).
    expect(() => z.toJSONSchema(discoveryReportSchema)).not.toThrow();
    expect(() => z.toJSONSchema(modelDossierSchema)).not.toThrow();
  });

  it("repairs model and imageUrl at the trust boundary, both lanes", () => {
    const rec = {
      make: "Toyota",
      model: "Yaris (XP90, 2006-2011)",
      imageUrl: "https://commons.wikimedia.org/wiki/File:TOYOTA_YARIS_(XP90).jpg",
      versions: ["1.33 Dual VVT-i"],
      avoidVersions: [],
      yearMin: 2006,
      yearMax: 2011,
      priceBandEur: { min: 4000, max: 6500 },
      whyFits: ["Barato de mantener"],
      watchouts: ["Consumo de aceite"],
      sources: ["https://example.com"],
    };
    const parsed = parseDiscoveryReport({
      headline: "Perfil de ciudad.",
      recommendations: [rec],
      discarded: [],
      sources: [],
    }).recommendations[0];
    expect(parsed?.model).toBe("Yaris");
    expect(parsed?.generation).toBe("XP90");
    expect(parsed?.imageUrl).toContain("Special:FilePath");
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

describe("discoveryResearchSchema", () => {
  it("does not ask research for a photo", () => {
    // Nine model-supplied URLs over two days, nine broken images. The model
    // cannot find photos; code resolves them afterwards.
    const shape = z.toJSONSchema(discoveryResearchSchema) as unknown as {
      properties: { recommendations: { items: { properties: Record<string, unknown> } } };
    };
    const fields = shape.properties.recommendations.items.properties;
    expect(fields).not.toHaveProperty("imageUrl");
    expect(fields).toHaveProperty("bodyStyle");
  });

  it("still converts to JSON Schema for structured output", () => {
    // A .transform() here throws at request time only — invisible to tests.
    expect(() => z.toJSONSchema(discoveryResearchSchema)).not.toThrow();
  });

  it("accepts a report that stores a photo we resolved ourselves", () => {
    const stored = parseDiscoveryReport({
      headline: "h",
      recommendations: [
        {
          make: "Toyota",
          model: "Yaris",
          generation: "XP90",
          bodyStyle: "hatchback",
          imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/A.jpg?width=640",
          versions: [],
          avoidVersions: [],
          priceBandEur: { min: 4000, max: 6500 },
          whyFits: [],
          watchouts: [],
          sources: [],
        },
      ],
      discarded: [],
      sources: [],
    });
    expect(stored.recommendations[0]?.bodyStyle).toBe("hatchback");
    expect(stored.recommendations[0]?.imageUrl).toContain("Special:FilePath");
  });
});

describe("normalizeBodyStyle", () => {
  // Structured output does NOT constrain this field — the SDK turns a zod enum
  // into a plain string — so whatever research writes has to be survivable.
  it("passes through the vocabulary we asked for", () => {
    expect(normalizeBodyStyle("hatchback")).toBe("hatchback");
    expect(normalizeBodyStyle("MPV")).toBe("MPV");
  });

  it("translates what research actually writes in Spanish", () => {
    expect(normalizeBodyStyle("berlina")).toBe("sedan");
    expect(normalizeBodyStyle("familiar")).toBe("estate");
    expect(normalizeBodyStyle("descapotable")).toBe("convertible");
    expect(normalizeBodyStyle("monovolumen")).toBe("MPV");
    expect(normalizeBodyStyle("utilitario")).toBe("hatchback");
  });

  it("copes with a qualified phrase instead of a bare word", () => {
    expect(normalizeBodyStyle("hatchback 5 puertas")).toBe("hatchback");
    expect(normalizeBodyStyle("Berlina 4p")).toBe("sedan");
  });

  it("drops what it cannot place instead of rejecting the report", () => {
    // The whole point: a body we don't recognise must not cost minutes of
    // paid research. No body just means the older photo heuristic applies.
    expect(normalizeBodyStyle("nosequé")).toBeUndefined();
    expect(normalizeBodyStyle(undefined)).toBeUndefined();
  });

  it("survives a report whose body is free text", () => {
    const parsed = parseDiscoveryReport({
      headline: "h",
      recommendations: [
        {
          make: "Toyota",
          model: "Yaris",
          bodyStyle: "utilitario de 5 puertas",
          versions: [],
          avoidVersions: [],
          priceBandEur: { min: 4000, max: 6500 },
          whyFits: [],
          watchouts: [],
          sources: [],
        },
      ],
      discarded: [],
      sources: [],
    });
    expect(parsed.recommendations[0]?.bodyStyle).toBe("hatchback");
  });
});

describe("normalizeDrivetrain", () => {
  // No marketplace states drivetrain as a field, so it is read out of the ad
  // text — and sellers almost never write "4x4", they write the trade name.
  it("reads the manufacturers' trade names, not just the digits", () => {
    expect(normalizeDrivetrain("1.6 CRDi 136 HTRAC Style")).toBe("4x4");
    expect(normalizeDrivetrain("2.5 AWD-i Advance")).toBe("4x4");
    expect(normalizeDrivetrain("2.0 TDI 4Motion DSG")).toBe("4x4");
    expect(normalizeDrivetrain("3.0 TDI quattro")).toBe("4x4");
    expect(normalizeDrivetrain("1.4 AllGrip")).toBe("4x4");
    expect(normalizeDrivetrain("xDrive20d")).toBe("4x4");
  });

  it("reads plain Spanish too", () => {
    expect(normalizeDrivetrain("Tucson tracción total")).toBe("4x4");
    expect(normalizeDrivetrain("SUV 4x4 impecable")).toBe("4x4");
    expect(normalizeDrivetrain("tracción delantera")).toBe("4x2");
    expect(normalizeDrivetrain("1.6 GDi 4x2 Klass")).toBe("4x2");
  });

  it("reads across the fields an ad spreads it over", () => {
    // Version, title and description together — sellers put it anywhere.
    expect(normalizeDrivetrain("1.6 GDi Klass", "Hyundai Tucson", "con HTRAC")).toBe("4x4");
  });

  it("stays silent when the ad never says", () => {
    // Silence must not be read as 4x2: an unknown drivetrain is neutral in
    // the benchmark, and guessing here would price cars against the wrong pool.
    expect(normalizeDrivetrain("1.6 GDi Klass 4x4 no, mejor")).toBe("4x4"); // literal mention wins
    expect(normalizeDrivetrain("2.0 TDI 150 Style")).toBeUndefined();
    expect(normalizeDrivetrain(undefined)).toBeUndefined();
    expect(normalizeDrivetrain("")).toBeUndefined();
  });
});

describe("normalizeDrivetrain against real ad text", () => {
  // Every string here is from the live corpus on 2026-07-28. Dealer
  // boilerplate is the adversary: it is long, Spanish, and full of words that
  // look like drivetrain tokens.
  const BOILERPLATE =
    "Bienvenido a AUTOPAI. Garantía total, revisión integral, cámara trasera, " +
    "financiación a medida. Vehículo NACIONAL, GASOLINA HÍBRIDO con CAMBIO " +
    "AUTOMÁTICO y tracción 4x2. Etiqueta ECO. ÚNICO PROPIETARIO.";

  it("does not read 'garantía total' or 'revisión integral' as all-wheel drive", () => {
    // The live failure: a RAV4 whose title said 4X2 came back 4x4, because
    // bare "total"/"integral" matched the dealer's warranty blurb.
    expect(normalizeDrivetrain("Toyota RAV4 2.5 STYLE 218cv. 4X2 HÍBRIDO AUT", BOILERPLATE)).toBe("4x2");
  });

  it("does not let 'tracción 4x2' match the 4x4 rule through its first digit", () => {
    expect(normalizeDrivetrain("tracción 4x2")).toBe("4x2");
    expect(normalizeDrivetrain("tracción total")).toBe("4x4");
  });

  it("does not read 'cámara trasera' as rear-wheel drive", () => {
    expect(normalizeDrivetrain("Toyota RAV4 2.5l 220H Luxury 4WD", "cámara trasera y sensores")).toBe("4x4");
  });

  it("still says nothing when the ad says nothing", () => {
    expect(normalizeDrivetrain("Toyota RAV4 2024", "Coche impecable, siempre en garaje.")).toBeUndefined();
    expect(normalizeDrivetrain("Peugeot 207 RC 2007")).toBeUndefined();
  });
});
