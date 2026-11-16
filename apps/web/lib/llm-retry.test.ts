import { describe, expect, it } from "vitest";
import { isRetryThrottled, LLM_RETRY_DAILY_CEILING } from "./llm-retry";

const now = new Date("2026-11-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("isRetryThrottled", () => {
  it("lets a lead with no failures through", () => {
    expect(isRetryThrottled([], now)).toBe(false);
  });

  it("holds a lead that failed within the hour", () => {
    expect(isRetryThrottled([minutesAgo(15)], now)).toBe(true);
    expect(isRetryThrottled([minutesAgo(59)], now)).toBe(true);
  });

  it("retries once the cooldown has passed", () => {
    expect(isRetryThrottled([minutesAgo(61)], now)).toBe(false);
    expect(isRetryThrottled([minutesAgo(61), minutesAgo(200)], now)).toBe(false);
  });

  it("stops at the daily ceiling even when every failure is past the cooldown", () => {
    const failures = Array.from({ length: LLM_RETRY_DAILY_CEILING }, (_, i) =>
      minutesAgo(90 + i * 90),
    );
    expect(isRetryThrottled(failures, now)).toBe(true);
  });

  it("forgets failures older than a day", () => {
    const old = [minutesAgo(25 * 60), minutesAgo(26 * 60), minutesAgo(27 * 60)];
    expect(isRetryThrottled(old, now)).toBe(false);
  });
});
