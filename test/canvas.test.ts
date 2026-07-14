import { describe, expect, it } from "vitest";

import { elementLabel } from "../src/canvas";

describe("elementLabel", () => {
  it("labels each element type compactly", () => {
    expect(elementLabel({ type: "contact", tag: "a", mode: "NO" })).toBe("] [ a");
    expect(elementLabel({ type: "contact", tag: "b", mode: "NC" })).toBe("]/[ b");
    expect(elementLabel({ type: "compare", op: "GE", left: "t", right: 21 })).toBe(
      "[ t ≥ 21 ]",
    );
    expect(
      elementLabel({ type: "fb", instance: "t1" }, { t1: { type: "TON", preset_ms: 5 } }),
    ).toBe("TON t1");
    expect(elementLabel({ type: "fb", instance: "x" })).toBe("FB x");
    expect(elementLabel({ type: "not" })).toBe("NOT");
    expect(elementLabel({ branch: [[], []] })).toBe("OR (2)");
  });

  it("shows a placeholder for an unbound tag", () => {
    expect(elementLabel({ type: "contact", tag: "", mode: "NO" })).toBe("] [ ?");
  });
});
