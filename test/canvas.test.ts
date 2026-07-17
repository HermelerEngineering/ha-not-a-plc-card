import { describe, expect, it } from "vitest";

import {
  RungDropTarget,
  elementLabel,
  hitRung,
  nearestSlot,
  nearestTarget,
  reorderDelta,
} from "../src/canvas";

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

describe("hitRung", () => {
  const geoms = [
    { ri: 0, top: 0, bottom: 40, slotXs: [10, 60, 110] },
    { ri: 1, top: 52, bottom: 92, slotXs: [10, 60] },
  ];
  it("finds the rung under y and the nearest slot for x", () => {
    expect(hitRung(geoms, 58, 20)).toEqual({ ri: 0, index: 1 });
    expect(hitRung(geoms, 12, 70)).toEqual({ ri: 1, index: 0 });
    expect(hitRung(geoms, 200, 88)).toEqual({ ri: 1, index: 1 }); // x clamps to last slot
  });
  it("returns null when y is outside every rung band (e.g. the gap between)", () => {
    expect(hitRung(geoms, 30, 46)).toBeNull(); // in the 40..52 gap
    expect(hitRung(geoms, 30, 500)).toBeNull(); // below all rungs
  });
  it("padBottom extends a rung's zone down into the gap (coil append drops)", () => {
    // y=46 is in the gap just below rung 0; with pad it resolves to rung 0.
    expect(hitRung(geoms, 58, 46, 12)).toEqual({ ri: 0, index: 1 });
    // The extended zone stops at the next rung's top, so rung 1 still wins there.
    expect(hitRung(geoms, 12, 60, 12)).toEqual({ ri: 1, index: 0 });
  });
});

describe("nearestTarget", () => {
  // A top-level slot (full-height band) and a nested slot in row 0 of a branch.
  const targets: RungDropTarget[] = [
    { ri: 0, steps: [], index: 1, x: 100, top: 0, bottom: 56 },
    { ri: 0, steps: [{ index: 1, path: 0 }], index: 0, x: 115, top: 0, bottom: 28 },
    { ri: 0, steps: [], index: 2, x: 200, top: 0, bottom: 56 },
  ];
  it("picks the horizontally nearest slot whose band contains y", () => {
    // Near the top-level slot column.
    expect(nearestTarget(targets, 101, 40)?.index).toBe(1);
    // Near the nested slot (only in-band for the top half) → inside the branch.
    expect(nearestTarget(targets, 116, 10)?.steps).toEqual([{ index: 1, path: 0 }]);
    // In the lower half, the nested slot's band excludes y, so top-level wins.
    expect(nearestTarget(targets, 116, 45)?.steps).toEqual([]);
  });
  it("returns null when y is over no band (e.g. below every slot)", () => {
    expect(nearestTarget(targets, 100, 999)).toBeNull();
  });
});
