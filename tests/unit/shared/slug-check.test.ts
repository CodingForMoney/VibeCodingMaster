import { describe, expect, it } from "vitest";
import { validateTaskSlug } from "../../../src/shared/validation/slug-check.js";

describe("validateTaskSlug", () => {
  it("accepts lowercase task slugs", () => {
    expect(validateTaskSlug("fix-refund-flow").ok).toBe(true);
  });

  it("rejects uppercase and consecutive hyphens", () => {
    expect(validateTaskSlug("Fix-Refund").ok).toBe(false);
    expect(validateTaskSlug("fix--refund").ok).toBe(false);
  });
});
