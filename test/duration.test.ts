import { describe, expect, it } from "vitest";

import { formatDuration, parseDuration } from "../src/duration";

describe("parseDuration", () => {
  it("parses each unit suffix", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("3m")).toBe(180_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("treats a bare number as seconds", () => {
    expect(parseDuration("5")).toBe(5000);
    expect(parseDuration("0")).toBe(0);
  });

  it("accepts decimals, whitespace and mixed case", () => {
    expect(parseDuration("2.5m")).toBe(150_000);
    expect(parseDuration(" 1.5 s ")).toBe(1500);
    expect(parseDuration("1H")).toBe(3_600_000);
  });

  it("returns undefined for unparseable input", () => {
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("abc")).toBeUndefined();
    expect(parseDuration("5x")).toBeUndefined();
    expect(parseDuration("-5s")).toBeUndefined();
    expect(parseDuration("5s 3m")).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("uses the largest unit that divides exactly", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(180_000)).toBe("3m");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(1500)).toBe("1500ms");
    expect(formatDuration(0)).toBe("0s");
  });

  it("returns '' for an invalid value", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });

  it("round-trips through parseDuration", () => {
    for (const ms of [500, 5000, 180_000, 3_600_000, 90_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });
});
