import { describe, expect, it } from "vitest";
import {
  CHAT_MAX_CHARS,
  composeCounterReply,
  composeFollowUpMessage,
  composeNudgeMessage,
  composeOfferMessage,
  composeOpeningMessage,
  composeTriageLine,
  composeUnitLine,
  computeOfferEur,
  respondToCounterEur,
} from "./compose.js";
import type { ConfidenceVerdict } from "./domain.js";

const verdict = (over: Partial<ConfidenceVerdict>): ConfidenceVerdict =>
  ({ overall: "C", score: 60, confidencePct: 40, openQuestions: [], ...over }) as ConfidenceVerdict;

describe("composeOpeningMessage", () => {
  it("greets the seller by first name and asks the questions informally", () => {
    const msg = composeOpeningMessage({
      title: "Porsche Boxster S 3.4",
      sellerName: "Juan M.",
      openQuestions: ["¿Tiene el mantenimiento al día con facturas?"],
    });
    expect(msg).toMatch(/^(Hola|Buenas|Qué tal), Juan!/);
    expect(msg).toContain("Tiene el mantenimiento al día con facturas?");
  });

  it("never uses inverted marks or list markers", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      sellerName: "Vanesa R.",
      openQuestions: ["¿Cuántos propietarios ha tenido?", "el volante es a la izquierda"],
    });
    expect(msg).not.toMatch(/[¿¡]/);
    expect(msg).not.toMatch(/^- /m);
    expect(msg).toContain("El volante es a la izquierda?");
  });

  it("caps the opener at three questions", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      openQuestions: ["una?", "dos?", "tres?", "cuatro?", "cinco?"],
    });
    expect(msg).toContain("Tres?");
    expect(msg).not.toContain("uatro");
  });

  it("falls back to a plain availability opener without questions", () => {
    const msg = composeOpeningMessage({ title: "Golf", openQuestions: [] });
    expect(msg).toMatch(/(sigue disponible|lo tienes todavía|lo sigues vendiendo)\?$/);
  });

  it("varies greeting/closing across leads but stays deterministic", () => {
    const a = composeOpeningMessage({ title: "Golf GTI 2017", openQuestions: ["una?"] });
    const again = composeOpeningMessage({ title: "Golf GTI 2017", openQuestions: ["una?"] });
    expect(a).toBe(again);
    // Across many seeds, more than one closing must appear.
    const closings = new Set(
      Array.from({ length: 12 }, (_, i) =>
        composeOpeningMessage({ title: `Coche ${i}`, openQuestions: ["una?"] })
          .trimEnd()
          .split("\n")
          .at(-1),
      ),
    );
    expect(closings.size).toBeGreaterThan(1);
  });

  it("ignores non-name seller display names", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      sellerName: "A. 24",
      openQuestions: [],
    });
    expect(msg).toMatch(/^(Hola|Buenas|Qué tal)! /);
  });
});

describe("composeTriageLine", () => {
  it("tells the reader to pursue good grades and skip bad ones", () => {
    expect(composeTriageLine(verdict({ overall: "B" }))).toContain("escribir al vendedor");
    expect(composeTriageLine(verdict({ overall: "E" }))).toContain("pasa");
  });

  it("makes an over-budget C conditional on the seller clearing risks", () => {
    const line = composeTriageLine(
      verdict({
        overall: "C",
        repairExposureEur: { min: 2750, max: 6150 },
        budgetNote: "Peor caso ~6.150 € → total ~21.150 €, por encima de tu presupuesto de 14.500 €",
      }),
    );
    expect(line).toContain("descartando riesgos");
    // es-ES only groups 5+ digits: 6150 stays ungrouped.
    expect(line).toContain("6150");
  });

  it("vetoes override everything", () => {
    expect(composeTriageLine(verdict({ overall: "B", vetoes: ["scam_price"] }))).toContain("Descártalo");
  });
});

describe("composeUnitLine", () => {
  const withLlm = (keyLine?: string): ConfidenceVerdict =>
    verdict({
      overall: "B",
      llm: keyLine
        ? { summary: "s", keyLine, redFlags: [], greenFlags: [], model: "m", at: "t" }
        : undefined,
    });

  it("uses the LLM keyLine unique to the unit when present", () => {
    const line = composeUnitLine(
      withLlm("Merece la pena: pocos km y full equipe, pero 1.300 € más al contado."),
    );
    expect(line).toContain("pocos km");
  });

  it("falls back to the deterministic triage line without a keyLine", () => {
    expect(composeUnitLine(withLlm())).toBe(composeTriageLine(withLlm()));
  });

  it("a veto suppresses the friendly keyLine", () => {
    const vetoed = verdict({
      overall: "B",
      vetoes: ["scam_price"],
      llm: { summary: "s", keyLine: "coche estupendo", redFlags: [], greenFlags: [], model: "m", at: "t" },
    });
    expect(composeUnitLine(vetoed)).toContain("Descártalo");
  });
});

describe("chat length limit", () => {
  const longQuestions = [
    "¿Tiene el libro de mantenimiento completamente al día con todas las facturas de las revisiones oficiales?",
    "¿Cuántos propietarios ha tenido el coche desde que se matriculó por primera vez en España?",
    "¿Ha tenido algún accidente o reparación importante de chapa, pintura o mecánica que haya que conocer?",
  ];

  it("openers drop questions to fit Wallapop's 300-char composer", () => {
    const msg = composeOpeningMessage({
      title: "Ford Focus 1.0 EcoBoost 125 CV Trend+ 5 puertas",
      sellerName: "María de las Mercedes",
      openQuestions: longQuestions,
    });
    expect(msg.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(msg).toContain("libro de mantenimiento"); // best question survives
  });

  it("follow-ups drop questions to fit", () => {
    const msg = composeFollowUpMessage({
      openQuestions: longQuestions,
      alreadyAsked: [],
      sellerReplies: 1,
    });
    expect(msg!.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
  });

  it("the real Ford offer that got cut now fits, price included", () => {
    // 409 chars before this fix — Wallapop cut it at 300, losing the price.
    const msg = composeOfferMessage({
      askingPriceEur: 15000,
      maxBudgetEur: 14500,
      repairExposureEur: { min: 2150, max: 4950 },
      pendingRisks: [
        "1.0 EcoBoost: pérdida de refrigerante por el manguito degas → sobrecalentamiento y culata agrietada",
        "Silentblocks y bieletas del tren trasero/delantero gastados",
      ],
      seed: "7b7775bd-1a10-478e-84c0-251074564e85",
    });
    expect(msg!.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(msg).toContain("13.200");
  });

  it("merged follow-up + offer fits with the price intact", () => {
    const msg = composeFollowUpMessage({
      openQuestions: ["¿En qué taller Ford lo llevaban y de cuándo es la factura de la correa?"],
      alreadyAsked: [],
      sellerReplies: 3,
      offer: {
        askingPriceEur: 15000,
        maxBudgetEur: 14500,
        repairExposureEur: { min: 2150, max: 4950 },
        pendingRisks: [
          "1.0 EcoBoost: pérdida de refrigerante por el manguito degas → culata agrietada",
          "Silentblocks y bieletas del tren trasero/delantero gastados",
        ],
      },
    });
    expect(msg!.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(msg).toContain("13.200");
  });
});

describe("computeOfferEur", () => {
  it("asks the seller to absorb half the expected repairs, capped at budget", () => {
    // Focus case: 15.000 asking, 14.500 budget, 2.150-4.950 exposure.
    expect(
      computeOfferEur({
        askingPriceEur: 15000,
        maxBudgetEur: 14500,
        repairExposureEur: { min: 2150, max: 4950 },
      }),
    ).toBe(13200);
  });

  it("never exceeds the user's budget even without exposure", () => {
    expect(computeOfferEur({ askingPriceEur: 16000, maxBudgetEur: 14500 })).toBe(14500);
  });

  it("is null when there is nothing to negotiate", () => {
    expect(computeOfferEur({ askingPriceEur: 13000, maxBudgetEur: 14500 })).toBeNull();
  });

  it("never lowballs under 80% of asking", () => {
    expect(
      computeOfferEur({
        askingPriceEur: 10000,
        maxBudgetEur: 14500,
        repairExposureEur: { min: 8000, max: 12000 },
      }),
    ).toBe(8000);
  });
});

describe("composeOfferMessage", () => {
  const input = {
    askingPriceEur: 15000,
    maxBudgetEur: 14500,
    repairExposureEur: { min: 2150, max: 4950 },
    pendingRisks: ["1.0 EcoBoost: pérdida de refrigerante por el manguito degas → culata agrietada"],
    seed: "lead-focus",
  };

  it("puts a justified number on the table, informally", () => {
    const msg = composeOfferMessage(input);
    expect(msg).toContain("13.200");
    expect(msg).toContain("pérdida de refrigerante por el manguito degas");
    // es-ES only groups 5+ digits: 2150 stays ungrouped.
    expect(msg).toContain("entre 2150 y 4950 €");
    expect(msg!.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(msg).not.toMatch(/[¿¡]/);
    expect(msg).not.toMatch(/^- /m);
    expect(msg).toBe(composeOfferMessage(input));
  });

  it("strips the engine prefix and consequence tail from risk titles", () => {
    const msg = composeOfferMessage(input);
    expect(msg).not.toContain("1.0 EcoBoost:");
    expect(msg).not.toContain("culata agrietada");
  });

  it("justifies with budget when no risks remain", () => {
    const msg = composeOfferMessage({
      askingPriceEur: 16000,
      maxBudgetEur: 14500,
      seed: "x",
    });
    expect(msg).toContain("14.500");
    expect(msg).toContain("16.000");
    expect(msg).toMatch(/presupuesto|gastarme/);
  });

  it("is null when the asking price is already right", () => {
    expect(
      composeOfferMessage({ askingPriceEur: 13000, maxBudgetEur: 14500, seed: "x" }),
    ).toBeNull();
  });
});

describe("respondToCounterEur", () => {
  it("splits the difference on the real Ford counter", () => {
    // We offered 13.200, she countered 14.500, cap 14.500 → split 13.900.
    expect(
      respondToCounterEur({ ourLastOfferEur: 13200, sellerCounterEur: 14500, maxBudgetEur: 14500 }),
    ).toEqual({ action: "counter", priceEur: 13900 });
  });

  it("accepts when the seller comes down to our number or below", () => {
    expect(
      respondToCounterEur({ ourLastOfferEur: 13200, sellerCounterEur: 13000, maxBudgetEur: 14500 }),
    ).toEqual({ action: "accept", priceEur: 13000 });
  });

  it("accepts a counter within one small step under budget", () => {
    expect(
      respondToCounterEur({ ourLastOfferEur: 13200, sellerCounterEur: 13400, maxBudgetEur: 14500 }),
    ).toEqual({ action: "accept", priceEur: 13400 });
  });

  it("never counters above the budget cap", () => {
    const d = respondToCounterEur({
      ourLastOfferEur: 14000,
      sellerCounterEur: 15800,
      maxBudgetEur: 14500,
    });
    expect(d.priceEur).toBeLessThanOrEqual(14500);
  });

  it("stands on our number when there is no room left under the cap", () => {
    expect(
      respondToCounterEur({ ourLastOfferEur: 14500, sellerCounterEur: 15500, maxBudgetEur: 14500 }),
    ).toEqual({ action: "stand", priceEur: 14500 });
  });
});

describe("composeCounterReply", () => {
  it("carries the code-decided number, fits the chat, stays informal", () => {
    const msg = composeCounterReply({
      ourLastOfferEur: 13200,
      sellerCounterEur: 14500,
      maxBudgetEur: 14500,
      seed: "lead-focus",
    });
    expect(msg).toContain("13.900");
    expect(msg.length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
    expect(msg).not.toMatch(/[¿¡]/);
    expect(msg).toBe(
      composeCounterReply({
        ourLastOfferEur: 13200,
        sellerCounterEur: 14500,
        maxBudgetEur: 14500,
        seed: "lead-focus",
      }),
    );
  });

  it("an acceptance finally proposes the visit", () => {
    const msg = composeCounterReply({
      ourLastOfferEur: 13200,
      sellerCounterEur: 13200,
      maxBudgetEur: 14500,
      seed: "x",
    });
    expect(msg).toContain("13.200");
    expect(msg).toMatch(/verlo|pasarme/);
  });
});

describe("composeNudgeMessage", () => {
  it("is a short question-free reminder, deterministic per seed", () => {
    const a = composeNudgeMessage("lead-1");
    expect(a).toBe(composeNudgeMessage("lead-1"));
    expect(a).not.toMatch(/[¿¡]/);
    expect(a.split("\n")).toHaveLength(1);
  });
});

describe("composeFollowUpMessage", () => {
  it("carries only the questions not yet asked", () => {
    const sent = composeOpeningMessage({
      title: "Boxster",
      openQuestions: ["¿Quién asume la rematriculación en España?"],
    });
    const followUp = composeFollowUpMessage({
      openQuestions: [
        "¿Quién asume la rematriculación en España?",
        "¿Tiene el libro de mantenimiento al día?",
        "¿Cuántos propietarios ha tenido?",
      ],
      alreadyAsked: [sent],
    });
    expect(followUp).toContain("Tiene el libro de mantenimiento al día?");
    expect(followUp).toContain("Cuántos propietarios ha tenido?");
    expect(followUp).not.toContain("rematriculación");
    expect(followUp).not.toMatch(/[¿¡]/);
  });

  it("is null when everything was already asked", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿una cosa?"],
      alreadyAsked: ["Hola!\nUna cosa?\nGracias!"],
    });
    expect(followUp).toBeNull();
  });

  it("still dedups against messages sent in the old formal style", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Quién asume la rematriculación? ¿Qué documentación tiene?"],
      alreadyAsked: ["Hola, Robert:\n- ¿Quién asume la rematriculación? ¿Qué documentación tiene?\n¡Gracias!"],
    });
    expect(followUp).toBeNull();
  });

  it("always thanks the seller before asking more", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 1,
    });
    expect(followUp).toMatch(/gracias/i);
  });

  it("warms up after a couple of seller replies and points toward a visit", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Está cambiada la correa de distribución?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 3,
    });
    expect(followUp).toMatch(/convenciendo|cuadra|interesa más/);
    expect(followUp).toMatch(/verlo|pasarme/);
    expect(followUp).not.toMatch(/[¿¡]/);
  });

  it("matches the singular/plural of the remaining questions", () => {
    const one = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?"],
      alreadyAsked: [],
    });
    expect(one).toMatch(/una cosa más|una duda|última cosa/i);
    const many = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?", "¿Cuántos dueños?"],
      alreadyAsked: [],
    });
    expect(many).toMatch(/par de cosas|par de dudas/i);
  });

  const offerFixture = {
    askingPriceEur: 15000,
    maxBudgetEur: 14500,
    repairExposureEur: { min: 2150, max: 4950 },
    pendingRisks: ["1.0 EcoBoost: pérdida de refrigerante por el manguito degas → culata"],
  };

  it("merges the offer into the last warm batch of questions", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿En qué taller Ford lo llevaban?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 3,
      offer: offerFixture,
    });
    expect(followUp).toContain("En qué taller Ford lo llevaban?");
    expect(followUp).toContain("13.200");
    // The visit is only contingent on the number — never promised first.
    expect(followUp).not.toContain("Con esto ya me decido");
    expect(followUp).not.toMatch(/[¿¡]/);
  });

  it("does not anchor a price mid-interrogation", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿una?", "¿dos?", "¿tres?", "¿cuatro?", "¿cinco?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 3,
      offer: offerFixture,
    });
    expect(followUp).not.toContain("13.200");
    // …and while negotiation is pending it never promises the visit either.
    expect(followUp).not.toMatch(/me decido|pasarme a verlo|hablamos de verlo/);
  });

  it("does not negotiate while the conversation is still cold", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 1,
      offer: offerFixture,
    });
    expect(followUp).not.toContain("13.200");
  });

  it("still promises the visit when there is nothing to negotiate", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
      sellerReplies: 3,
    });
    expect(followUp).toMatch(/verlo|pasarme/);
  });

  it("does not close with the same word as the opener's default", () => {
    const followUp = composeFollowUpMessage({
      openQuestions: ["¿Tiene ITV en vigor?"],
      alreadyAsked: ["Hola! Me interesa el coche."],
    });
    expect(followUp).toBeTruthy();
    // Follow-up closings come from their own pool; whatever the seed picks,
    // the message must end in a closing, not in a bare question.
    expect(followUp!.trimEnd()).toMatch(/(saludo!|gracias!|Gracias!)$/i);
  });
});
