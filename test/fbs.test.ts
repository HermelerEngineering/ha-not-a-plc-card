import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import {
  FB_TYPES,
  addFb,
  fbFields,
  fbNumericOutputs,
  fbOutputRefs,
  freshFbName,
  isFbReferenced,
  isSourceType,
  newFb,
  removeFb,
  renameFb,
  setFbParam,
  setFbType,
} from "../src/fbs";

describe("fb type metadata", () => {
  it("lists the implemented block types", () => {
    expect(FB_TYPES).toEqual([
      "R_TRIG",
      "F_TRIG",
      "TON",
      "TOF",
      "TP",
      "CTU",
      "CTD",
      "SR",
      "RS",
      "CLOCK",
    ]);
  });

  it("marks CLOCK as a source block (declared, never placed in a rung)", () => {
    expect(isSourceType("CLOCK")).toBe(true);
    expect(isSourceType("TON")).toBe(false);
    expect(fbFields("CLOCK")).toEqual([]); // no parameters
  });

  it("knows each type's numeric outputs", () => {
    expect(fbNumericOutputs("TON")).toEqual(["ET"]);
    expect(fbNumericOutputs("CTU")).toEqual(["CV"]);
    expect(fbNumericOutputs("CLOCK")).toEqual([
      "H",
      "M",
      "S",
      "TOD",
      "WD",
      "D",
      "MO",
      "Y",
    ]);
    expect(fbNumericOutputs("R_TRIG")).toEqual([]);
  });

  it("enumerates the instance.OUTPUT refs a program offers", () => {
    const program = {
      tags: {},
      fbs: { clock: { type: "CLOCK" }, t1: { type: "TON", preset_ms: 1000 } },
      networks: [],
    } as Program;
    expect(fbOutputRefs(program)).toEqual([
      "clock.D",
      "clock.H",
      "clock.M",
      "clock.MO",
      "clock.S",
      "clock.TOD",
      "clock.WD",
      "clock.Y",
      "t1.ET",
    ]);
  });

  it("describes the editable fields per type", () => {
    // Stored in ms, but entered/shown as a duration (5s / 3m / 1h).
    expect(fbFields("TON")).toEqual([
      { key: "preset_ms", kind: "duration", label: "preset" },
    ]);
    expect(fbFields("CTU").map((f) => f.key)).toEqual(["pv", "reset"]);
    expect(fbFields("CTD").map((f) => f.key)).toEqual(["pv", "load"]);
    expect(fbFields("SR")).toEqual([{ key: "reset", kind: "tag", label: "reset" }]);
    expect(fbFields("R_TRIG")).toEqual([]);
  });

  it("newFb seeds sensible defaults", () => {
    expect(newFb("TON")).toEqual({ type: "TON", preset_ms: 1000 });
    expect(newFb("CTU")).toEqual({ type: "CTU", pv: 1 });
    expect(newFb("SR")).toEqual({ type: "SR" });
    expect(newFb("R_TRIG")).toEqual({ type: "R_TRIG" });
  });
});

function prog(): Program {
  return {
    tags: {
      go: { kind: "input", type: "BOOL", source: "binary_sensor.go" },
      done: { kind: "coil", type: "BOOL" },
    },
    fbs: { t1: { type: "TON", preset_ms: 500 } },
    networks: [
      {
        id: "n1",
        rungs: [
          {
            id: "r1",
            series: [
              { type: "contact", tag: "go" },
              { type: "fb", instance: "t1" },
            ],
            coils: [{ type: "coil", tag: "done" }],
          },
          {
            id: "r2",
            series: [
              { branch: [[{ type: "compare", op: "GE", left: "t1.ET", right: 250 }]] },
            ],
            coils: [{ type: "coil", tag: "done" }],
          },
        ],
      },
    ],
  };
}

describe("add / remove / fresh name", () => {
  it("adds a uniquely-named instance and removes it", () => {
    const { program, name } = addFb(prog(), "CTU");
    expect(name).toBe("fb1");
    expect(program.fbs?.fb1).toEqual({ type: "CTU", pv: 1 });
    expect(removeFb(program, "fb1").fbs?.fb1).toBeUndefined();
  });

  it("freshFbName avoids existing instance names", () => {
    const p = { ...prog(), fbs: { fb1: { type: "TP", preset_ms: 100 } } };
    expect(freshFbName(p)).toBe("fb2");
  });
});

describe("setFbType / setFbParam", () => {
  it("changing type resets params to the new type's defaults", () => {
    const p = setFbType(prog(), "t1", "CTU");
    expect(p.fbs?.t1).toEqual({ type: "CTU", pv: 1 });
  });

  it("sets and clears parameters", () => {
    let p = setFbParam(prog(), "t1", "preset_ms", 750);
    expect(p.fbs?.t1.preset_ms).toBe(750);
    p = setFbParam(p, "t1", "preset_ms", "");
    expect(p.fbs?.t1.preset_ms).toBeUndefined();
  });
});

describe("isFbReferenced", () => {
  it("finds fb-element and compare-operand references (incl. nested)", () => {
    expect(isFbReferenced(prog(), "t1")).toBe(true);
    expect(isFbReferenced(prog(), "other")).toBe(false);
  });
});

describe("renameFb", () => {
  it("rewrites the fb element, the dotted compare operand and the key", () => {
    const p = renameFb(prog(), "t1", "timer");
    expect(p.fbs?.timer).toBeDefined();
    expect(p.fbs?.t1).toBeUndefined();
    const fbEl = p.networks[0].rungs[0].series[1] as { instance: string };
    expect(fbEl.instance).toBe("timer");
    const cmp = (
      p.networks[0].rungs[1].series[0] as { branch: { left: string }[][] }
    ).branch[0][0];
    expect(cmp.left).toBe("timer.ET");
  });

  it("is a no-op on collision with a tag or existing instance", () => {
    const p = prog();
    expect(renameFb(p, "t1", "done")).toBe(p); // tag name
    expect(renameFb(p, "t1", "t1")).toBe(p);
    expect(renameFb(p, "t1", "")).toBe(p);
  });
});
