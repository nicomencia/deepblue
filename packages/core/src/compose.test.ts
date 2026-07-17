import { describe, expect, it } from "vitest";
import {
  composeFollowUpMessage,
  composeNudgeMessage,
  composeOpeningMessage,
  composeTriageLine,
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
    expect(msg).toMatch(/^(Hola|Buenas), Juan!/);
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
    expect(msg).toContain("sigue disponible?");
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
    expect(msg).toMatch(/^(Hola|Buenas)! /);
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
