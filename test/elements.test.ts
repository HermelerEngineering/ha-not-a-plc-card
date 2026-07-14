import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import {
  BranchEl,
  ContactEl,
  NotEl,
} from "../src/ir";
import {
  addCoil,
  addElement,
  addElementIn,
  addNetwork,
  addRung,
  freshId,
  moveElement,
  moveRung,
  newBranch,
  newCoil,
  newContact,
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
  it("build empty containers ready to fill", () => {
    expect(newBranch()).toEqual({ branch: [[], []] });
    expect(newNot()).toEqual({ not: [] });
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

  it("adds inside a NOT group's inner series", () => {
    const base: Program = {
      tags: { a: { kind: "input", type: "BOOL", source: "binary_sensor.a" } },
      networks: [
        {
          id: "n1",
          rungs: [{ id: "r1", series: [newNot()], coils: [newCoil("a")] }],
        },
      ],
    };
    const p = addElementIn(base, 0, 0, [{ index: 0 }], newContact("a"));
    const not = p.networks[0].rungs[0].series[0] as NotEl;
    expect(not.not).toHaveLength(1);
    expect((not.not[0] as ContactEl).tag).toBe("a");
  });
});
