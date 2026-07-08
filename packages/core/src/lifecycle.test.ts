import { describe, expect, it } from "vitest";
import { DEFAULT_RECHECK_HOURS, dueForRecheck } from "./lifecycle.js";

describe("dueForRecheck", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it("is not due for a freshly-seen listing", () => {
    expect(dueForRecheck(hoursAgo(1), now)).toBe(false);
    expect(dueForRecheck(now, now)).toBe(false);
  });

  it("is due once past the recheck window (default 36h)", () => {
    expect(dueForRecheck(hoursAgo(DEFAULT_RECHECK_HOURS - 1), now)).toBe(false);
    expect(dueForRecheck(hoursAgo(DEFAULT_RECHECK_HOURS), now)).toBe(true);
    expect(dueForRecheck(hoursAgo(72), now)).toBe(true);
  });

  it("honors a custom window", () => {
    expect(dueForRecheck(hoursAgo(5), now, 6)).toBe(false);
    expect(dueForRecheck(hoursAgo(6), now, 6)).toBe(true);
    expect(dueForRecheck(hoursAgo(1), now, 0)).toBe(true); // 0h = probe everything
  });
});
