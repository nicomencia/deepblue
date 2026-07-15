import { describe, expect, it } from "vitest";
import { extractCashPriceEur, extractDedupKey, extractFirstImageUrl, extractImportSignals, fingerprintDedupKey, sanitizePowerCv } from "./extract.js";

// Real Flexicar boilerplate, abridged — the pattern that motivated the rule.
const FLEXICAR_AD = `Llegan las mejores ofertas
Precio al contado: 13.490€ (IVA incluido)
Precio alternativo oferta de financiación: 11.490€ (IVA incluido) financiando el 100% del importe
REF: 903000000234676`;

describe("extractCashPriceEur", () => {
  it("parses the Flexicar cash-price format, not the financing price", () => {
    expect(extractCashPriceEur(FLEXICAR_AD, 11_490)).toBe(13_490);
  });

  it("accepts loose variants: no 'precio', spaces as thousand separators, any case", () => {
    expect(extractCashPriceEur("se vende AL CONTADO: 9990€", 9_990)).toBe(9_990);
    expect(extractCashPriceEur("precio al contado 13 490 €")).toBe(13_490);
  });

  it("ignores decimals after a comma instead of mangling them", () => {
    expect(extractCashPriceEur("al contado: 13.490,50 €")).toBe(13_490);
  });

  it("returns undefined when the text has no cash-price marker", () => {
    expect(extractCashPriceEur("Golf en perfecto estado, 12.000 €")).toBeUndefined();
    expect(extractCashPriceEur(undefined)).toBeUndefined();
    expect(extractCashPriceEur("")).toBeUndefined();
  });

  it("rejects values outside the sane range for a car", () => {
    expect(extractCashPriceEur("al contado: 300 €")).toBeUndefined();
  });

  it("rejects values wildly out of proportion with the listed price", () => {
    expect(extractCashPriceEur("al contado: 14.000 €", 4_000)).toBeUndefined(); // > 3x
    expect(extractCashPriceEur("al contado: 4.000 €", 14_000)).toBeUndefined(); // < 1/3
    // The real bait gap (headline 9.990, cash 14.490) must survive the guard.
    expect(extractCashPriceEur("al contado: 14.490 €", 9_990)).toBe(14_490);
  });
});

describe("extractDedupKey", () => {
  it("builds a platform-scoped key from the dealer internal REF", () => {
    expect(extractDedupKey("wallapop", FLEXICAR_AD)).toBe("wallapop|ref:903000000234676");
  });

  it("accepts REF punctuation and case variants", () => {
    expect(extractDedupKey("wallapop", "ref. 123456 final")).toBe("wallapop|ref:123456");
    expect(extractDedupKey("wallapop", "REF 9876543")).toBe("wallapop|ref:9876543");
  });

  it("ignores numbers too short to be a real reference", () => {
    expect(extractDedupKey("wallapop", "REF: 12345")).toBeUndefined();
  });

  it("returns undefined without a REF or without text", () => {
    expect(extractDedupKey("wallapop", "Golf de 2018, único dueño")).toBeUndefined();
    expect(extractDedupKey("wallapop", undefined)).toBeUndefined();
  });
});

describe("extractFirstImageUrl", () => {
  const modern = {
    images: [
      {
        id: "36edord3l9yj",
        urls: {
          big: "https://cdn.wallapop.com/images/x.jpg?pictureSize=W800",
          small: "https://cdn.wallapop.com/images/x.jpg?pictureSize=W320",
          medium: "https://cdn.wallapop.com/images/x.jpg?pictureSize=W640",
        },
        average_color: "13C1AC",
      },
      { urls: { medium: "https://cdn.wallapop.com/images/second.jpg" } },
    ],
  };

  it("takes the FIRST image at medium size from the modern urls shape", () => {
    expect(extractFirstImageUrl(modern)).toBe(
      "https://cdn.wallapop.com/images/x.jpg?pictureSize=W640",
    );
  });

  it("unwraps stored raw columns shaped { detail, user, stats }", () => {
    expect(extractFirstImageUrl({ detail: modern, user: null, stats: null })).toBe(
      "https://cdn.wallapop.com/images/x.jpg?pictureSize=W640",
    );
  });

  it("falls back through big/small when medium is missing", () => {
    expect(
      extractFirstImageUrl({ images: [{ urls: { big: "https://cdn.wallapop.com/b.jpg" } }] }),
    ).toBe("https://cdn.wallapop.com/b.jpg");
  });

  it("reads the legacy flat shape", () => {
    expect(
      extractFirstImageUrl({
        images: [{ original: "https://cdn.wallapop.com/o.jpg", small: "https://cdn.wallapop.com/s.jpg" }],
      }),
    ).toBe("https://cdn.wallapop.com/o.jpg");
  });

  it("returns undefined on empty, malformed, or absent images", () => {
    expect(extractFirstImageUrl({ images: [] })).toBeUndefined();
    expect(extractFirstImageUrl({ images: [{ urls: {} }] })).toBeUndefined();
    expect(extractFirstImageUrl({ title: "no images" })).toBeUndefined();
    expect(extractFirstImageUrl(null)).toBeUndefined();
    expect(extractFirstImageUrl("string")).toBeUndefined();
    expect(extractFirstImageUrl({ images: [{ urls: { medium: "not-a-url" } }] })).toBeUndefined();
  });
});

describe("fingerprintDedupKey", () => {
  // The real AUTOHERO case: one Golf, seven city accounts, no REF anywhere.
  const autohero = {
    platform: "wallapop",
    make: "Volkswagen",
    model: "Golf",
    version: "1.0 TSI Advance",
    year: 2018,
    km: 122_065,
    priceEur: 14_199,
  };

  it("produces the same key for the same unit across accounts", () => {
    expect(fingerprintDedupKey(autohero)).toBe(
      "wallapop|fp:volkswagen|golf|1.0 tsi advance|2018|122065|14199",
    );
    expect(fingerprintDedupKey({ ...autohero })).toBe(fingerprintDedupKey(autohero));
  });

  it("normalizes case and whitespace so account typos don't split the key", () => {
    expect(
      fingerprintDedupKey({ ...autohero, make: "VOLKSWAGEN", version: "1.0  TSI   Advance " }),
    ).toBe(fingerprintDedupKey(autohero));
  });

  it("differs when any identity field differs", () => {
    expect(fingerprintDedupKey({ ...autohero, km: 122_066 })).not.toBe(
      fingerprintDedupKey(autohero),
    );
    expect(fingerprintDedupKey({ ...autohero, priceEur: 14_200 })).not.toBe(
      fingerprintDedupKey(autohero),
    );
  });

  it("never fingerprints rounded odometers (dealer templates, not readings)", () => {
    expect(fingerprintDedupKey({ ...autohero, km: 120_000 })).toBeUndefined();
    expect(fingerprintDedupKey({ ...autohero, km: 89_500 })).toBeUndefined();
    expect(fingerprintDedupKey({ ...autohero, km: 500 })).toBeUndefined();
  });

  it("never fingerprints with missing fields", () => {
    expect(fingerprintDedupKey({ ...autohero, km: undefined })).toBeUndefined();
    expect(fingerprintDedupKey({ ...autohero, year: undefined })).toBeUndefined();
    expect(fingerprintDedupKey({ ...autohero, make: undefined })).toBeUndefined();
    expect(fingerprintDedupKey({ ...autohero, priceEur: undefined })).toBeUndefined();
  });

  it("tolerates a missing version (same unit listed with and without trim)", () => {
    expect(fingerprintDedupKey({ ...autohero, version: undefined })).toBe(
      "wallapop|fp:volkswagen|golf||2018|122065|14199",
    );
  });
});

describe("sanitizePowerCv", () => {
  it("passes plausible whole-CV values through", () => {
    expect(sanitizePowerCv(110)).toBe(110);
    expect(sanitizePowerCv(20)).toBe(20);
    expect(sanitizePowerCv(1500)).toBe(1500);
  });

  it("rejects the real-world garbage: displacement typed as horsepower", () => {
    expect(sanitizePowerCv(1.4)).toBeUndefined();
    expect(sanitizePowerCv(2.0)).toBeUndefined();
  });

  it("rejects out-of-range and non-finite values", () => {
    expect(sanitizePowerCv(19)).toBeUndefined();
    expect(sanitizePowerCv(1501)).toBeUndefined();
    expect(sanitizePowerCv(NaN)).toBeUndefined();
    expect(sanitizePowerCv(Infinity)).toBeUndefined();
    expect(sanitizePowerCv(undefined)).toBeUndefined();
  });
});

describe("extractImportSignals", () => {
  it("detects the real case: RHD in the title", () => {
    expect(extractImportSignals("Porsche Boxster 2005 Manual RHD", undefined)).toEqual({
      rhd: true,
      rhdAssumed: false,
      foreignPlate: false,
    });
  });

  it("assumes RHD on UK origin unless the ad claims left-hand drive", () => {
    // The real S 3.4 case: "matricula inglesa" (no accent), volante unstated.
    const s34 = extractImportSignals(
      "Porsche Boxster S 3.4",
      "Vehiculo con papeles y matricula inglesa.",
    );
    expect(s34).toEqual({ rhd: true, rhdAssumed: true, foreignPlate: true });

    const lhd = extractImportSignals(undefined, "matrícula inglesa, volante a la izquierda");
    expect(lhd.rhd).toBe(false);
    expect(lhd.foreignPlate).toBe(true);

    // A German import is LHD country — no RHD assumption.
    expect(extractImportSignals(undefined, "matrícula alemana").rhd).toBe(false);
  });

  it("detects RHD phrasings in Spanish", () => {
    expect(extractImportSignals(undefined, "volante a la derecha, muy cuidado").rhd).toBe(true);
    expect(extractImportSignals(undefined, "coche con volante inglés").rhd).toBe(true);
    expect(extractImportSignals(undefined, "conducción a la derecha").rhd).toBe(true);
  });

  it("detects foreign plates and pending re-registration", () => {
    expect(extractImportSignals(undefined, "matrícula inglesa, se vende por mudanza").foreignPlate).toBe(true);
    expect(extractImportSignals(undefined, "matrícula francesa").foreignPlate).toBe(true);
    expect(extractImportSignals(undefined, "pendiente de matricular en España").foreignPlate).toBe(true);
    expect(extractImportSignals(undefined, "rematriculación a cargo del comprador").foreignPlate).toBe(true);
  });

  it("an explicit Spanish registration wins over import mentions", () => {
    expect(
      extractImportSignals(undefined, "importado de Alemania, ya matriculado en España").foreignPlate,
    ).toBe(false);
    expect(
      extractImportSignals(undefined, "matrícula española, fue matrícula francesa").foreignPlate,
    ).toBe(false);
  });

  it("stays quiet on ordinary ads", () => {
    expect(extractImportSignals("Golf VII 1.4 TSI", "coche nacional, único dueño")).toEqual({
      rhd: false,
      rhdAssumed: false,
      foreignPlate: false,
    });
  });
});
