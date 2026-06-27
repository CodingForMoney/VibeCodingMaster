import { describe, expect, it } from "vitest";
import { isManualInterruptInput, isSafeTerminalResize } from "../../../src/backend/ws/terminal-ws.js";

describe("isSafeTerminalResize", () => {
  it("rejects hidden-container and invalid terminal sizes", () => {
    expect(isSafeTerminalResize(0, 0)).toBe(false);
    expect(isSafeTerminalResize(8, 24)).toBe(false);
    expect(isSafeTerminalResize(120, 2)).toBe(false);
    expect(isSafeTerminalResize(80.5, 24)).toBe(false);
    expect(isSafeTerminalResize(Number.NaN, 24)).toBe(false);
  });

  it("allows normal terminal sizes", () => {
    expect(isSafeTerminalResize(20, 5)).toBe(true);
    expect(isSafeTerminalResize(120, 40)).toBe(true);
  });

  it("detects Ctrl+C input without treating normal text as an interrupt", () => {
    expect(isManualInterruptInput("\u0003")).toBe(true);
    expect(isManualInterruptInput("abc\u0003def")).toBe(true);
    expect(isManualInterruptInput("hello")).toBe(false);
  });
});
