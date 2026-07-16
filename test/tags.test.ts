import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import {
  addTag,
  domainsForType,
  freshTagName,
  inferType,
  isTagReferenced,
  removeTag,
  renameTag,
  setKind,
} from "../src/tags";

describe("inferType", () => {
  it("maps numeric domains to REAL and the rest to BOOL", () => {
    expect(inferType("sensor.temperature")).toBe("REAL");
    expect(inferType("input_number.setpoint")).toBe("REAL");
    expect(inferType("number.x")).toBe("REAL");
    expect(inferType("binary_sensor.motion")).toBe("BOOL");
    expect(inferType("input_boolean.flag")).toBe("BOOL");
    expect(inferType("switch.pump")).toBe("BOOL");
    expect(inferType("light.hall")).toBe("BOOL");
  });
});

describe("domainsForType", () => {
  it("offers numeric domains for REAL and boolean domains for BOOL", () => {
    expect(domainsForType("REAL")).toContain("sensor");
    expect(domainsForType("REAL")).not.toContain("binary_sensor");
    expect(domainsForType("BOOL")).toContain("binary_sensor");
    expect(domainsForType("BOOL")).not.toContain("sensor");
  });
});

describe("setKind", () => {
  it("drops fields that no longer apply to the new kind", () => {
    const input = { kind: "input" as const, type: "REAL" as const, source: "sensor.t" };
    const coil = setKind(input, "coil");
    expect(coil).toEqual({ kind: "coil", type: "REAL" });

    const mem = setKind({ kind: "memory", type: "BOOL", retain: true }, "temp");
    expect(mem).toEqual({ kind: "temp", type: "BOOL" });

    const withWrites = {
      kind: "coil" as const,
      type: "BOOL" as const,
      writes: { target: "switch.p" },
    };
    expect(setKind(withWrites, "memory")).toEqual({ kind: "memory", type: "BOOL" });
  });

  it("preserves the applicable fields", () => {
    const coil = { kind: "coil" as const, type: "BOOL" as const, writes: { target: "switch.p" } };
    expect(setKind(coil, "coil")).toEqual(coil);
  });
});

function progWith(): Program {
  return {
    tags: {
      a: { kind: "input", type: "BOOL", source: "binary_sensor.a" },
      b: { kind: "input", type: "REAL", source: "sensor.b" },
      out: { kind: "coil", type: "BOOL" },
      m: { kind: "memory", type: "BOOL" },
    },
    fbs: { c1: { type: "CTU", pv: 3, reset: "a" } },
    networks: [
      {
        id: "n",
        rungs: [
          {
            id: "r",
            series: [
              {
                branch: [
                  [{ type: "contact", tag: "a" }],
                  [{ type: "compare", op: "GT", left: "b", right: "b" }],
                ],
              },
            ],
            coils: [{ type: "coil", tag: "out" }],
          },
        ],
      },
    ],
  };
}

describe("isTagReferenced", () => {
  it("detects references in contacts, compares, coils and fb params", () => {
    const p = progWith();
    expect(isTagReferenced(p, "a")).toBe(true); // contact + fb reset
    expect(isTagReferenced(p, "b")).toBe(true); // compare left/right
    expect(isTagReferenced(p, "out")).toBe(true); // coil
    expect(isTagReferenced(p, "m")).toBe(false); // declared but unused
  });
});

describe("renameTag", () => {
  it("rewrites every reference across the IR", () => {
    const p = renameTag(progWith(), "a", "start");
    expect(p.tags.start).toBeDefined();
    expect(p.tags.a).toBeUndefined();
    expect(p.fbs?.c1.reset).toBe("start");
    const branch = p.networks[0].rungs[0].series[0] as {
      branch: { type: string; tag?: string }[][];
    };
    expect(branch.branch[0][0].tag).toBe("start");
  });

  it("rewrites both compare operands and the coil target", () => {
    const p = renameTag(renameTag(progWith(), "b", "temp_c"), "out", "lamp");
    const cmp = (
      p.networks[0].rungs[0].series[0] as {
        branch: { left?: string; right?: string | number }[][];
      }
    ).branch[1][0];
    expect(cmp.left).toBe("temp_c");
    expect(cmp.right).toBe("temp_c");
    expect((p.networks[0].rungs[0].coils[0] as { tag: string }).tag).toBe("lamp");
  });

  it("is a no-op on a name collision or empty name", () => {
    const p = progWith();
    expect(renameTag(p, "a", "b")).toBe(p);
    expect(renameTag(p, "a", "")).toBe(p);
    expect(renameTag(p, "a", "a")).toBe(p);
  });
});

describe("addTag / removeTag / freshTagName", () => {
  it("adds a unique default tag and removes it again", () => {
    const p0 = progWith();
    const { program, name } = addTag(p0);
    expect(name).toBe("tag");
    expect(program.tags.tag).toEqual({ kind: "memory", type: "BOOL" });

    const { name: name2 } = addTag(program);
    expect(name2).toBe("tag_2");

    expect(removeTag(program, "tag").tags.tag).toBeUndefined();
  });

  it("freshTagName avoids existing names", () => {
    const p = progWith();
    expect(freshTagName(p, "a")).toBe("a_2");
    expect(freshTagName(p, "z")).toBe("z");
  });
});
