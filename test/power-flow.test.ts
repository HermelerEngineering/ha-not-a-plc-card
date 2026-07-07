import { describe, expect, it } from "vitest";

import { BranchEl, ContactEl, NotEl, Program, Rung } from "../src/ir";
import {
  computePowerFlow,
  elementConducts,
  seriesConducts,
  truthy,
} from "../src/power-flow";

const NO = (tag: string): ContactEl => ({ type: "contact", tag, mode: "NO" });
const NC = (tag: string): ContactEl => ({ type: "contact", tag, mode: "NC" });

describe("truthy", () => {
  it("coerces the process-image value types the engine uses", () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
    expect(truthy(1)).toBe(true);
    expect(truthy(0)).toBe(false);
    expect(truthy(undefined)).toBe(false);
    expect(truthy(null)).toBe(false);
  });
});

describe("elementConducts", () => {
  it("handles NO / NC contacts", () => {
    expect(elementConducts(NO("a"), { a: true })).toBe(true);
    expect(elementConducts(NO("a"), { a: false })).toBe(false);
    expect(elementConducts(NC("a"), { a: true })).toBe(false);
    expect(elementConducts(NC("a"), { a: false })).toBe(true);
    // Missing tag reads false.
    expect(elementConducts(NO("a"), {})).toBe(false);
    expect(elementConducts(NC("a"), {})).toBe(true);
  });

  it("ORs the paths of a branch", () => {
    const branch: BranchEl = { branch: [[NO("a")], [NO("b")]] };
    expect(elementConducts(branch, { a: false, b: false })).toBe(false);
    expect(elementConducts(branch, { a: true, b: false })).toBe(true);
    expect(elementConducts(branch, { a: false, b: true })).toBe(true);
  });

  it("negates an inner series for NOT", () => {
    const not: NotEl = { not: [NO("a")] };
    expect(elementConducts(not, { a: true })).toBe(false);
    expect(elementConducts(not, { a: false })).toBe(true);
  });
});

describe("seriesConducts", () => {
  it("ANDs every position and treats an empty chain as conducting", () => {
    expect(seriesConducts([NO("a"), NO("b")], { a: true, b: true })).toBe(true);
    expect(seriesConducts([NO("a"), NO("b")], { a: true, b: false })).toBe(false);
    expect(seriesConducts([], {})).toBe(true);
  });
});

function ohmRung(): Rung {
  return {
    id: "r",
    series: [NO("a"), NO("b")],
    coils: [{ type: "coil", tag: "out", mode: "=" }],
  };
}

function program(rungs: Rung[]): Program {
  return {
    tags: {},
    networks: [{ id: "n", rungs }],
  };
}

describe("computePowerFlow", () => {
  it("lights the whole series and energises the coil when power reaches it", () => {
    const rung = ohmRung();
    const flow = computePowerFlow(program([rung]), { a: true, b: true, out: true });

    expect(flow.elements.get(rung.series[0])).toEqual({ conducts: true, live: true });
    expect(flow.elements.get(rung.series[1])).toEqual({ conducts: true, live: true });
    expect(flow.rungs.get(rung)).toEqual({ result: true });
    expect(flow.coils.get(rung.coils[0])).toEqual({ energised: true, value: true });
  });

  it("stops power at the first non-conducting element", () => {
    const rung = ohmRung();
    const flow = computePowerFlow(program([rung]), { a: false, b: true, out: false });

    // First contact does not conduct: it is not live and neither is the rest.
    expect(flow.elements.get(rung.series[0])).toEqual({ conducts: false, live: false });
    // Second conducts on its own, but no power reaches it.
    expect(flow.elements.get(rung.series[1])).toEqual({ conducts: true, live: false });
    expect(flow.rungs.get(rung)).toEqual({ result: false });
    expect(flow.coils.get(rung.coils[0])).toEqual({ energised: false, value: false });
  });

  it("colours a branch path only as far as power flows", () => {
    const branch: BranchEl = { branch: [[NO("a"), NO("b")], [NO("c")]] };
    const rung: Rung = {
      id: "r",
      series: [branch],
      coils: [{ type: "coil", tag: "out" }],
    };
    const flow = computePowerFlow(program([rung]), { a: true, b: false, c: true });

    // Path 1 breaks at b; path 2 conducts, so the branch is live overall.
    expect(flow.elements.get(branch)?.live).toBe(true);
    const [p1, p2] = branch.branch;
    expect(flow.elements.get(p1[0])?.live).toBe(true); // a: powered + conducts
    expect(flow.elements.get(p1[1])?.live).toBe(false); // b: no power past a
    expect(flow.elements.get(p2[0])?.live).toBe(true); // c conducts
    expect(flow.rungs.get(rung)?.result).toBe(true);
  });

  it("exposes coil value separately from energisation for S/R coils", () => {
    // Rung not energised this scan, but the retained bit is on in the image.
    const rung: Rung = {
      id: "r",
      series: [NO("set")],
      coils: [{ type: "coil", tag: "m", mode: "S" }],
    };
    const flow = computePowerFlow(program([rung]), { set: false, m: true });

    expect(flow.coils.get(rung.coils[0])).toEqual({ energised: false, value: true });
  });
});
