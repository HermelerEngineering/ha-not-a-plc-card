import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import { BranchEl, Coil, ContactEl } from "../src/ir";
import {
  addBranchPath,
  addCoil,
  addElement,
  addElementIn,
  addNetwork,
  addRung,
  freshId,
  insertCoil,
  moveCoil,
  moveCoilToRung,
  insertElementIn,
  moveElement,
  moveRung,
  newBranch,
  newCalc,
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
  cloneElement,
  elementAt,
  moveElementAcross,
  moveElementToRung,
  updateCoil,
  updateElement,
  updateElementIn,
  wrapInBranch,
} from "../src/elements";
import { Element, isBranch } from "../src/ir";

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

describe("wrapInBranch", () => {
  it("wraps the element in an OR branch with a second empty path to fill", () => {
    const p = wrapInBranch(prog(), 0, 0, [], 0);
    const el = p.networks[0].rungs[0].series[0];
    expect(isBranch(el)).toBe(true);
    if (isBranch(el)) {
      expect(el.branch).toHaveLength(2);
      expect(el.branch[0]).toEqual([newContact("a")]);
      expect(el.branch[1]).toEqual([]);
    }
  });

  it("leaves a branch unchanged (no branch-in-branch)", () => {
    const withBranch = updateElement(prog(), 0, 0, 0, newBranch());
    const p = wrapInBranch(withBranch, 0, 0, [], 0);
    expect(p.networks[0].rungs[0].series[0]).toEqual(newBranch());
  });

  it("wraps an element nested inside a branch path", () => {
    // a → branch[[c]] ; wrap the inner contact c.
    let p = updateElement(prog(), 0, 0, 0, { branch: [[newContact("c")]] });
    p = wrapInBranch(p, 0, 0, [{ index: 0, path: 0 }], 0);
    const outer = p.networks[0].rungs[0].series[0];
    if (isBranch(outer)) {
      const inner = outer.branch[0][0];
      expect(isBranch(inner)).toBe(true);
      if (isBranch(inner)) expect(inner.branch[0]).toEqual([newContact("c")]);
    }
  });
});

/** A two-rung, two-network program for cross-rung move tests. */
function prog2(): Program {
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
          { id: "r1", series: [newContact("a"), newContact("b")], coils: [newCoil("out")] },
          { id: "r2", series: [newContact("c")], coils: [newCoil("out")] },
        ],
      },
      {
        id: "n2",
        rungs: [{ id: "r1", series: [newContact("d")], coils: [newCoil("out")] }],
      },
    ],
  };
}

describe("cloneElement", () => {
  it("deep-copies an element so the copy is independent", () => {
    const branch = { branch: [[newContact("a"), newContact("b")], [newContact("c")]] };
    const copy = cloneElement(branch);
    expect(copy).toEqual(branch);
    expect(copy).not.toBe(branch);
    if (isBranch(copy)) {
      // Mutating the copy must not touch the original.
      copy.branch[0][0] = newContact("z");
      expect((branch.branch[0][0] as { tag: string }).tag).toBe("a");
    }
  });
});

describe("moveElementToRung", () => {
  it("moves an element to another rung in the same network", () => {
    const p = moveElementToRung(
      prog2(),
      { ni: 0, ri: 0, steps: [], ei: 0 }, // contact "a" from r1
      { ni: 0, ri: 1, steps: [], index: 1 }, // to r2, after "c"
    );
    expect(p.networks[0].rungs[0].series).toEqual([newContact("b")]);
    expect(p.networks[0].rungs[1].series).toEqual([newContact("c"), newContact("a")]);
  });

  it("moves an element to a rung in another network", () => {
    const p = moveElementToRung(
      prog2(),
      { ni: 0, ri: 0, steps: [], ei: 1 }, // contact "b"
      { ni: 1, ri: 0, steps: [], index: 0 }, // to n2/r1, before "d"
    );
    expect(p.networks[0].rungs[0].series).toEqual([newContact("a")]);
    expect(p.networks[1].rungs[0].series).toEqual([newContact("b"), newContact("d")]);
  });

  it("within one rung it reduces to a reorder (self-removal shift handled)", () => {
    const p = moveElementToRung(
      prog2(),
      { ni: 0, ri: 0, steps: [], ei: 0 },
      { ni: 0, ri: 0, steps: [], index: 2 },
    );
    expect(p.networks[0].rungs[0].series).toEqual([newContact("b"), newContact("a")]);
  });
});

describe("elementAt", () => {
  it("resolves a top-level and a nested element by its path", () => {
    const p = prog();
    p.networks[0].rungs[0].series = [
      newContact("a"),
      { branch: [[newContact("b"), newContact("c")]] },
    ];
    expect(elementAt(p, 0, 0, [], 0)).toEqual(newContact("a"));
    expect(elementAt(p, 0, 0, [{ index: 1, path: 0 }], 1)).toEqual(newContact("c"));
    expect(elementAt(p, 0, 0, [], 9)).toBeUndefined();
  });
});

describe("moveElementAcross", () => {
  function withSeries(series: Element[]): Program {
    const p = prog();
    p.networks[0].rungs[0].series = series;
    return p;
  }

  it("reorders within the top-level series (self-removal shift)", () => {
    const p = withSeries([newContact("a"), newContact("b"), newContact("c")]);
    const r = moveElementAcross(p, 0, 0, { steps: [], ei: 0 }, { steps: [], index: 3 });
    expect(r.networks[0].rungs[0].series).toEqual([
      newContact("b"),
      newContact("c"),
      newContact("a"),
    ]);
  });

  it("moves a top-level element into a branch path (index corrected)", () => {
    const p = withSeries([newContact("a"), { branch: [[newContact("b")]] }]);
    // Drop `a` after `b` inside path 0. The branch is at top index 1; removing `a`
    // shifts it to 0, so the corrected target path is [{index:0,path:0}].
    const r = moveElementAcross(
      p,
      0,
      0,
      { steps: [], ei: 0 },
      { steps: [{ index: 1, path: 0 }], index: 1 },
    );
    const series = r.networks[0].rungs[0].series;
    expect(series).toHaveLength(1);
    const branch = series[0];
    if (isBranch(branch)) {
      expect(branch.branch[0]).toEqual([newContact("b"), newContact("a")]);
    }
  });

  it("moves a nested element out to the top level", () => {
    const p = withSeries([
      { branch: [[newContact("a"), newContact("b")]] },
      newContact("c"),
    ]);
    const r = moveElementAcross(
      p,
      0,
      0,
      { steps: [{ index: 0, path: 0 }], ei: 1 },
      { steps: [], index: 2 },
    );
    const series = r.networks[0].rungs[0].series;
    const branch = series[0];
    if (isBranch(branch)) expect(branch.branch[0]).toEqual([newContact("a")]);
    expect(series[1]).toEqual(newContact("c"));
    expect(series[2]).toEqual(newContact("b"));
  });

  it("refuses to drop an element into itself", () => {
    const p = withSeries([{ branch: [[newContact("a")]] }]);
    const r = moveElementAcross(
      p,
      0,
      0,
      { steps: [], ei: 0 },
      { steps: [{ index: 0, path: 0 }], index: 1 },
    );
    expect(r).toBe(p); // unchanged
  });
});

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
    expect((p2.networks[0].rungs[0].coils[0] as Coil).mode).toBe("S");
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

  it("adds a calc output with a default op", () => {
    expect(newCalc()).toEqual({ type: "calc", op: "ADD", dst: "", a: 0, b: 0 });
    expect(newCalc("DIV").op).toBe("DIV");
    const p = addCoil(prog(), 0, 0, newCalc("MUL"));
    expect(p.networks[0].rungs[0].coils[1]).toEqual({
      type: "calc",
      op: "MUL",
      dst: "",
      a: 0,
      b: 0,
    });
  });

  it("adds, updates and removes coils", () => {
    let p = addCoil(prog(), 0, 0, newCoil("out", "S"));
    expect(p.networks[0].rungs[0].coils).toHaveLength(2);
    p = updateCoil(p, 0, 0, 1, newCoil("out", "R"));
    expect((p.networks[0].rungs[0].coils[1] as Coil).mode).toBe("R");
    p = removeCoil(p, 0, 0, 0);
    expect(p.networks[0].rungs[0].coils).toHaveLength(1);
  });

  it("reorders outputs within a rung's coil stack", () => {
    let p = addCoil(prog(), 0, 0, newCoil("second"));
    p = addCoil(p, 0, 0, newCoil("third"));
    // coils = [out, second, third]; move the first down two positions.
    p = moveCoil(p, 0, 0, 0, 2);
    expect(p.networks[0].rungs[0].coils.map((c) => (c as Coil).tag)).toEqual([
      "second",
      "third",
      "out",
    ]);
    // Out-of-range delta leaves the order unchanged.
    const p2 = moveCoil(p, 0, 0, 0, -1);
    expect(p2.networks[0].rungs[0].coils.map((c) => (c as Coil).tag)).toEqual([
      "second",
      "third",
      "out",
    ]);
  });

  it("moves an output to another rung's coil stack (moveCoilToRung)", () => {
    let p = addRung(prog(), 0); // second rung r2
    p = addCoil(p, 0, 1, newCoil("other"));
    // r0 coils = [out]; r1 coils = [other]. Move r0's out to the front of r1.
    p = moveCoilToRung(p, { ni: 0, ri: 0, ci: 0 }, { ni: 0, ri: 1, index: 0 });
    expect(p.networks[0].rungs[0].coils).toHaveLength(0);
    expect(p.networks[0].rungs[1].coils.map((c) => (c as Coil).tag)).toEqual([
      "out",
      "other",
    ]);
  });

  it("moveCoilToRung within a rung reorders (self-removal shift corrected)", () => {
    let p = addCoil(prog(), 0, 0, newCoil("second"));
    p = addCoil(p, 0, 0, newCoil("third"));
    // [out, second, third]: move index 0 to the end (gap 3).
    p = moveCoilToRung(p, { ni: 0, ri: 0, ci: 0 }, { ni: 0, ri: 0, index: 3 });
    expect(p.networks[0].rungs[0].coils.map((c) => (c as Coil).tag)).toEqual([
      "second",
      "third",
      "out",
    ]);
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

  it("addBranchPath appends an OR-path (empty or seeded with an element)", () => {
    // Empty path appended: branch goes from 2 to 3 paths.
    let p = addBranchPath(progNested(), 0, 0, [], 0);
    let branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch).toHaveLength(3);
    expect(branch.branch[2]).toEqual([]);

    // Seeded path: the new (4th) path carries the given element.
    p = addBranchPath(p, 0, 0, [], 0, [newContact("a")]);
    branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch).toHaveLength(4);
    expect((branch.branch[3][0] as ContactEl).tag).toBe("a");
  });

  it("adds an inline NOT into a branch path alongside contacts", () => {
    // NOT is a leaf now: it just sits in the series like any other element.
    const p = addElementIn(progNested(), 0, 0, [{ index: 0, path: 1 }], newNot());
    const branch = p.networks[0].rungs[0].series[0] as BranchEl;
    expect(branch.branch[1]).toHaveLength(1);
    expect(branch.branch[1][0]).toEqual({ type: "not" });
  });
});
