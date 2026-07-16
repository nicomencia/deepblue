import { describe, expect, it } from "vitest";
import { composeOpeningMessage } from "./compose.js";

describe("composeOpeningMessage", () => {
  it("greets the seller by first name and lists questions", () => {
    const msg = composeOpeningMessage({
      title: "Porsche Boxster S 3.4",
      sellerName: "Juan M.",
      openQuestions: ["¿Tiene el mantenimiento al día con facturas?"],
    });
    expect(msg).toContain("Hola, Juan:");
    expect(msg).toContain("- ¿Tiene el mantenimiento al día con facturas?");
    // Questions presuppose availability — no redundant "¿sigue disponible?".
    expect(msg).toContain("¡Gracias!");
    expect(msg).not.toContain("¿Sigue disponible?");
  });

  it("caps the opener at three questions", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      openQuestions: ["¿una?", "¿dos?", "¿tres?", "¿cuatro?", "¿cinco?"],
    });
    expect(msg.match(/^- /gm)).toHaveLength(3);
    expect(msg).not.toContain("cuatro");
  });

  it("normalizes questions missing their marks and capitalization", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      openQuestions: ["el volante es a la izquierda"],
    });
    expect(msg).toContain("- ¿El volante es a la izquierda?");
  });

  it("falls back to a plain availability opener without questions", () => {
    const msg = composeOpeningMessage({ title: "Golf", openQuestions: [] });
    expect(msg).toContain("¿Sigue disponible?");
    expect(msg).not.toContain("- ");
  });

  it("ignores non-name seller display names", () => {
    const msg = composeOpeningMessage({
      title: "Golf",
      sellerName: "A. 24",
      openQuestions: [],
    });
    expect(msg.startsWith("Hola:")).toBe(true);
  });
});
