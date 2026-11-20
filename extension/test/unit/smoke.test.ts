import { describe, expect, it } from "vitest";
import { BRAND } from "../../src/shared/brand";

describe("smoke", () => {
  it("exposes the brand name", () => {
    // Only the shape is asserted, so a name change touches brand.ts alone.
    expect(BRAND.name).toMatch(/^[A-Za-z][A-Za-z0-9 ]*$/);
  });
});
