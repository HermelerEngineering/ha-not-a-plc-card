import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import { BranchEl, ContactEl } from "../src/ir";
import {
  addCoil,
  addElement,
  addElementIn,
  addNetwork,
  addRung,
  freshId,
  insertCoil,
  insertElementIn,
  moveElement,
  moveRung,
  newBranch,
  newCoil,
  newContact,
  newMove,
  newNot,
  removeCoil,
  removeElement,
  removeElementIn,
  removeNetwork,
  removeRung,
  setNetworkTitle,
  setRungTitle,
  updateCoil,
  updateElement,
  updateElementIn,
} from "../src/elements";

function prog(): Program {
  return {
    tags: {
      a: { kind: "input", type: "BOOL", source: "binary_sensor.a" },
      b: { kind: "input", type: "BOOL", source: "binary_sensor.b" },
      out: { kind: "coil", type: "BOOL" },
    },
    networks: [
      {
        id: "n1",
        rungs: [
          {
            id: "r1",
            series: [newContact("a")],
            coils: [newCoil("out")],
          },
        ],
      },
    ],
  };
}

describe("freshId", () => {
  it("returns a prefixed id that avoids collisions", () => {
    expect(freshId([], "n")).toBe("n1");
    expect(freshId(["n1"], "n")).toBe("n2");
    expect(freshId(["n1", "n2", "n3"], "n")).toBe("n4");
    // Skips past a taken candidate.
    expect(freshId(["n2"], "n")).toBe("n1");
  });
});

describe("network ops", () => {
  it("adds a network with one empty rung and unique id", () => {
    const p = addNetwork(prog());
    expect(p.networks).toHaveLength(2);
    expect(p.networks[1].id).toBe("n2");
    expect(p.networks[1].rungs).toHaveLength(1);
    expect(p.networks[1].rungs[0].series).toEqual([]);
  });

  it("removes a network and sets a title (immutably)", () => {
    const p0 = prog();
    expect(removeNetwork(p0, 0).networks).toHaveLength(0);
    const titled = setNetworkTitle(p0, 0, "Lights");
    expect(titled.networks[0].title).toBe("Lights");
    expect(setNetworkTitle(titled, 0, "").networks[0].title).toBeUndefined();
    // original untouched
    expect(p0.networks[0].title).toBeUndefined();
  });
});

describe("rung ops", () => {
  it("adds and removes rungs with unique ids", () => {
    const p = addRung(prog(), 0);
    expect(p.networks[0].rungs).toHaveLength(2);
    expect(p.networks[0].rungs[1].id).toBe("r2");
    expect(removeRung(p, 0, 0).networks[0].rungs[0].id).toBe("r2");
  });

  it("moves a rung and sets a title", () => {
    let p = addRung(prog(), 0); // r1, r2
    p = setRungTitle(p, 0, 1, "second");
    p = moveRung(p, 0, 1, -1); // r2 now first
    expect(p.networks[0].rungs[0].id).toBe("r2");
    expect(p.networks[0].rungs[0].title).toBe("second");
  });
});

describe("element ops", () => {
  it("adds, updates, moves and removes series elements", () => {
    let p = addElement(prog(), 0, 0, newContact("b"));
    expect(p.networks[0].rungs[0].series).toHaveLength(2);

    p = updateElement(p, 0, 0, 1, newContact("b", "NC"));
    const el1 = p.networks[0].rungs[0].series[1];
    expect(el1).toEqual({ type: "contact", tag: "b", mode: "NC" });

    p = moveElement(p, 0, 0, 1, -1); // b before a
    expect((p.networks[0].rungs[0].series[0] as { tag: string }).tag).toBe("b");

    p = removeElement(p, 0, 0, 0);
    expect(p.networks[0].rungs[0].series).toHaveLength(1);
  });

  it("inserts an element and a coil at a given position", () => {
    // Insert before the existing contact 'a' at index 0.
    const p = insertElementIn(prog(), 0, 0, [], 0, newContact("b"));
    const series = p.networks[0].rungs[0].series;
    expect((series[0] as { tag: string }).tag).toBe("b");
    expect((series[1] as { tag: string }).tag).toBe("a");

    const p2 = insertCoil(prog(), 0, 0, 0, newCoil("out", "S"));
    expect(p2.networks[0].rungs[0].coils).toHaveLength(2);
    expect(p2.networks[0].rungs[0].coils[0].mode).toBe("S");
  });

  it("adds and updates a move output alongside coils", () => {
    expect(newMove()).toEqual({ type: "move", dst: "", src: 0 });
    let p = addCoil(prog(), 0, 0, newMove("level", 42));
    expect(p.networks[0].rungs[0].coils[1]).toEqual({
      type: "move",
      dst: "level",
      src: 42,
    });
    p = updateCoil(p, 0, 0, 1, newMove("level", "sp"));
    expect(p.networks[0].rungs[0].coils[1]).toEqual({
      type: "move",
      dst: "level",
      src: "sp",
    });
  });

  it("adds, updates and removes coils", () => {
    let p = addCoil(prog(), 0, 0, newCoil("out", "S"));
    expect(p.networks[0].rungs[0].coils).toHaveLength(2);
    p = updateCoil(p, 0, 0, 1, newCoil("out", "R"));
    expect(p.networks[0].rungs[0].coils[1].mode).toBe("R");
    p = removeCoil(p, 0, 0, 0);
    expect(p.networks[0].rungs[0].coils).toHaveLength(1);
  });

  it("leaves the original program unchanged", () => {
    const p0 = prog();
    addElement(p0, 0, 0, newContact("b"));
    expect(p0.networks[0].rungs[0].series).toHaveLength(1);
  });

  it("is a safe no-op on out-of-range targets", () => {
    const p0 = prog();
    expect(addRung(p0, 5)).toBe(p0);
    expect(addElement(p0, 5, 0, newContact("b"))).toBe(p0);
    expect(addElement(p0, 0, 5, newContact("b"))).toBe(p0);
  });
});

function progNested(): Program {
  return {
    tags: {
      a: { kind: "input", type: "BOOL", source: "binary_sensor.a" },
      out: { kind: "coil", type: "BOOL" },
    },
    networks: [
      {
        id: "n1",
        rungs: [
          {
            id: "r1",
            series: [{ branch: [[newContact("a")], []] }],
            coils: [newCoil("out")],
          },
        ],
      },
    ],
  };
}

describe("constructors newBranch / newNot", () => {
  it("build a fresh branch and an inline NOT", () => {
    expect(newBranch()).toEqual({ branch: [[], []] });
    expect(newNot()).toEqual({ type: "not" });
  });
});

describe("nested series editing (SeriesStep path)", () => {
  it("adds/updates/removes inside a branch path", () => {
    // Add a contact into the (empty) second path of the branch.
    let p = addElementIn(progNested(), 0, 0, [{ index: 0, path: 1 }], newContact("a"));
    let branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch[1]).toHaveLength(1);
    expect((branch.branch[1][0] as ContactEl).tag).toBe("a");

    // Update it to NC.
    p = updateElementIn(p, 0, 0, [{ index: 0, path: 1 }], 0, newContact("a", "NC"));
    branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect((branch.branch[1][0] as ContactEl).mode).toBe("NC");

    // The first path is left untouched.
    expect(branch.branch[0]).toHaveLength(1);

    // Remove it again.
    p = removeElementIn(p, 0, 0, [{ index: 0, path: 1 }], 0);
    branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch[1]).toHaveLength(0);
  });

  it("adds an inline NOT into a branch path alongside contacts", () => {
    // NOT is a leaf now: it just sits in the series like any other element.
    const p = addElementIn(progNested(), 0, 0, [{ index: 0, path: 1 }], newNot());
    const branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch[1]).toHaveLength(1);
    expect(branch.branch[1][0]).toEqual({ type: "not" });
  });
});
