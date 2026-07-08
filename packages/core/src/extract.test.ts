import { describe, expect, it } from "vitest";
import { extractCashPriceEur, extractDedupKey } from "./extract.js";

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
