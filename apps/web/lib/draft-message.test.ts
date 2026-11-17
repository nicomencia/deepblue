import { beforeEach, describe, expect, it, vi } from "vitest";

// The model is mocked: what is under test is what code does with its answer.
let reply: Record<string, string> = {};
let configured = true;
vi.mock("./llm", () => ({
  isLlmConfigured: () => configured,
  getAnthropic: () => ({ messages: { create: async () => ({ reply }) } }),
  messageText: (msg: { reply: Record<string, string> }) => JSON.stringify(msg.reply),
}));

const { draftSellerProse } = await import("./draft-message");

const QUESTIONS = [
  "Se ha cambiado la cadena de distribución y el tensor? Hay factura?",
  "El turbo hace ruidos o pierde aceite?",
];
const FALLBACK = [
  "Hola, Juan! Me ha gustado bastante el anuncio y tengo un par de dudas.",
  ...QUESTIONS,
  "",
  "Gracias!",
].join("\n");
const base = { title: "Peugeot 207 RC", transcript: "", intent: "primer contacto", fallback: FALLBACK };

describe("draftSellerProse — questions are code's, not the model's", () => {
  beforeEach(() => {
    configured = true;
  });

  it("keeps the questions verbatim and lets the model write only the framing", async () => {
    reply = { intro: "Buenas Juan, el 207 me tiene enamorado, te pregunto dos cosillas.", closing: "Mil gracias!" };
    const r = await draftSellerProse({ ...base, questions: QUESTIONS });
    expect(r.model).not.toBe("deterministic");
    expect(r.text.split("\n")).toEqual([reply.intro, ...QUESTIONS, "", "Mil gracias!"]);
  });

  it("rejects a framing that smuggles in a question of its own", async () => {
    reply = { intro: "Buenas! Lo tienes todavía?", closing: "Gracias! Aceptarías un cambio?" };
    const r = await draftSellerProse({ ...base, questions: QUESTIONS });
    expect(r).toEqual({ text: FALLBACK, model: "deterministic" });
  });

  it("allows the closing to ask only when the base closing did (visit slot)", async () => {
    const withVisit = FALLBACK.replace("Gracias!", "Si todo cuadra, cuándo podría pasarme a verlo?");
    reply = { intro: "Buenas Juan!", closing: "Si me cuadra, cuándo me paso a verlo?" };
    const r = await draftSellerProse({ ...base, fallback: withVisit, questions: QUESTIONS });
    expect(r.model).not.toBe("deterministic");
    expect(r.text).toContain(QUESTIONS[0]);
  });

  it("falls back when the assembled message would overflow the chat limit", async () => {
    reply = { intro: "Buenas! ".repeat(30), closing: "Gracias!" };
    const r = await draftSellerProse({ ...base, questions: QUESTIONS });
    expect(r.model).toBe("deterministic");
  });

  it("full-message mode (no verdict questions) may not add questions either", async () => {
    const nudge = "Buenas! Pudiste mirar lo que te pregunté?";
    reply = { message: "Hola! Pudiste mirarlo? Y por cierto, cuántos km tiene?" };
    const r = await draftSellerProse({ ...base, fallback: nudge });
    expect(r).toEqual({ text: nudge, model: "deterministic" });
  });

  it("without an API key the deterministic draft goes out untouched", async () => {
    configured = false;
    const r = await draftSellerProse({ ...base, questions: QUESTIONS });
    expect(r).toEqual({ text: FALLBACK, model: "deterministic" });
  });
});
