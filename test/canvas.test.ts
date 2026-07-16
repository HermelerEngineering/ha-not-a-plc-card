import { describe, expect, it } from "vitest";

import { elementLabel, nearestSlot, reorderDelta } from "../src/canvas";

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

describe("nearestSlot", () => {
  const slots = [10, 60, 110, 160]; // 3 elements → 4 insertion slots
  it("returns the index of the closest slot x", () => {
    expect(nearestSlot(slots, 8)).toBe(0);
    expect(nearestSlot(slots, 58)).toBe(1);
    expect(nearestSlot(slots, 200)).toBe(3); // clamps to the last
    expect(nearestSlot(slots, -50)).toBe(0); // clamps to the first
  });
  it("breaks ties toward the earlier slot", () => {
    expect(nearestSlot(slots, 35)).toBe(0); // exactly between 10 and 60
  });
});

describe("reorderDelta", () => {
  it("is zero for a drop onto either of the element's own edges", () => {
    expect(reorderDelta(1, 1)).toBe(0); // slot before itself
    expect(reorderDelta(1, 2)).toBe(0); // slot after itself
  });
  it("moves left when dropping at an earlier slot", () => {
    expect(reorderDelta(2, 0)).toBe(-2);
    expect(reorderDelta(3, 1)).toBe(-2);
  });
  it("accounts for the self-removal shift when dropping to the right", () => {
    // element 0 dropped at the far end of a 3-element series (slot 3) → last.
    expect(reorderDelta(0, 3)).toBe(2);
    expect(reorderDelta(0, 2)).toBe(1);
  });
});
