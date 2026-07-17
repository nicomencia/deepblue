import { describe, expect, it } from "vitest";
import { medianSellerReplyMinutes, replyPollCooldownMinutes } from "./polling.js";

const at = (iso: string): Date => new Date(iso);

describe("medianSellerReplyMinutes", () => {
  it("is undefined before any exchange completes", () => {
    expect(medianSellerReplyMinutes([])).toBeUndefined();
    expect(
      medianSellerReplyMinutes([{ direction: "outbound", at: at("2026-07-17T10:00:00Z") }]),
    ).toBeUndefined();
  });

  it("pairs each sent message with the FIRST reply after it", () => {
    const median = medianSellerReplyMinutes([
      { direction: "outbound", at: at("2026-07-17T10:00:00Z") },
      { direction: "inbound", at: at("2026-07-17T10:10:00Z") }, // 10 min
      { direction: "inbound", at: at("2026-07-17T12:00:00Z") }, // double-text: ignored
      { direction: "outbound", at: at("2026-07-17T13:00:00Z") },
      { direction: "inbound", at: at("2026-07-17T13:30:00Z") }, // 30 min
    ]);
    expect(median).toBe(20); // median of [10, 30]
  });
});

describe("replyPollCooldownMinutes", () => {
  const now = at("2026-07-17T15:00:00Z");

  it("polls fast while a quick seller's answer is plausibly on its way", () => {
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-17T14:55:00Z"),
        lastInboundAt: at("2026-07-17T14:30:00Z"),
        medianReplyMinutes: 8,
      }),
    ).toBe(10); // half the median, floored at 10
  });

  it("caps the hot cadence at an hour for slow sellers", () => {
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-17T14:00:00Z"),
        lastInboundAt: at("2026-07-17T10:00:00Z"),
        medianReplyMinutes: 300,
      }),
    ).toBe(60);
  });

  it("backs off once the seller has taken twice their usual", () => {
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-17T11:00:00Z"), // waited 4 h, median 45 min
        lastInboundAt: at("2026-07-17T10:00:00Z"),
      }),
    ).toBe(90);
  });

  it("drops to six hours after a day of silence", () => {
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-15T15:00:00Z"),
        lastInboundAt: at("2026-07-15T14:00:00Z"),
      }),
    ).toBe(360);
  });

  it("checks once shortly after their reply to catch double-texts, then rarely", () => {
    // Our turn: seller spoke last.
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-17T14:00:00Z"),
        lastInboundAt: at("2026-07-17T14:45:00Z"),
      }),
    ).toBe(15);
    expect(
      replyPollCooldownMinutes({
        now,
        lastOutboundAt: at("2026-07-17T10:00:00Z"),
        lastInboundAt: at("2026-07-17T11:00:00Z"),
      }),
    ).toBe(180);
  });
});
