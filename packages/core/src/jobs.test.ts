import { describe, expect, it } from "vitest";
import { jobPayloadSchema, listingCheckResultSchema } from "./jobs.js";

describe("job payloads", () => {
  it("accepts a check_listing payload in the discriminated union", () => {
    const parsed = jobPayloadSchema.parse({
      type: "check_listing",
      platform: "wallapop",
      platformListingId: "123",
      url: "https://es.wallapop.com/item/x",
    });
    expect(parsed.type).toBe("check_listing");
  });

  it("still rejects unknown job types and platforms", () => {
    expect(jobPayloadSchema.safeParse({ type: "delete_everything", platform: "wallapop" }).success).toBe(false);
    expect(
      jobPayloadSchema.safeParse({ type: "check_listing", platform: "craigslist", platformListingId: "1" }).success,
    ).toBe(false);
  });
});

describe("listingCheckResultSchema", () => {
  it("accepts the three lifecycle statuses", () => {
    for (const status of ["active", "reserved", "gone"] as const) {
      expect(
        listingCheckResultSchema.parse({ platform: "wallapop", platformListingId: "1", status }).status,
      ).toBe(status);
    }
  });

  it("rejects an unknown status (trust boundary)", () => {
    expect(
      listingCheckResultSchema.safeParse({ platform: "wallapop", platformListingId: "1", status: "sold" }).success,
    ).toBe(false);
  });
});
