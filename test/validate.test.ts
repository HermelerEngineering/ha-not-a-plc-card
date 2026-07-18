import { describe, expect, it } from "vitest";

import { Program } from "../src/ir";
import { validateProgram } from "../src/validate";

function base(): Program {
  return {
    tags: {
      a: { kind: "input", type: "BOOL", source: "binary_sensor.a" },
      t: { kind: "input", type: "REAL", source: "sensor.t" },
      out: { kind: "coil", type: "BOOL" },
    },
    fbs: { c1: { type: "CTU", pv: 3 } },
    networks: [
      {
        id: "n1",
        rungs: [{ id: "r1", series: [{ type: "contact", tag: "a" }], coils: [{ type: "coil", tag: "out" }] }],
      },
    ],
  };
}

describe("validateProgram", () => {
  it("reports nothing for a well-formed program", () => {
    expect(validateProgram(base())).toEqual([]);
  });

  it("flags an empty and an unknown contact tag", () => {
    const p = base();
    p.networks[0].rungs[0].series = [
      { type: "contact", tag: "" },
      { type: "contact", tag: "ghost" },
    ];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain("contact is empty");
    expect(msgs).toContain('contact references unknown tag "ghost"');
  });

  it("attaches the element/coil position to each issue", () => {
    const p = base();
    p.networks[0].rungs[0].series = [
      { type: "contact", tag: "a" },
      { branch: [[{ type: "contact", tag: "ghost" }]] },
    ];
    p.networks[0].rungs[0].coils = [{ type: "coil", tag: "missing" }];
    const issues = validateProgram(p);
    const nested = issues.find((i) => i.message.includes("ghost"));
    expect(nested).toMatchObject({ steps: [{ index: 1, path: 0 }], ei: 0 });
    const coil = issues.find((i) => i.message.startsWith("coil"));
    expect(coil).toMatchObject({ ci: 0 });
    expect(coil?.steps).toBeUndefined();
  });

  it("checks compare operands, allowing numbers and fb outputs", () => {
    const p = base();
    // left = REAL tag (ok), right = fb output on a known instance (ok).
    p.networks[0].rungs[0].series = [{ type: "compare", op: "GT", left: "t", right: "c1.CV" }];
    expect(validateProgram(p)).toEqual([]);

    // right = unknown fb output → error; left empty → error.
    p.networks[0].rungs[0].series = [{ type: "compare", op: "GT", left: "", right: "x9.ET" }];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain("compare left operand is empty");
    expect(msgs).toContain('compare right operand references unknown function block "x9"');
  });

  it("flags an unknown function-block instance", () => {
    const p = base();
    p.networks[0].rungs[0].series = [{ type: "fb", instance: "nope" }];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain('references unknown function block "nope"');
  });

  it("descends into branch paths", () => {
    const p = base();
    p.networks[0].rungs[0].series = [
      { branch: [[{ type: "contact", tag: "a" }], [{ type: "contact", tag: "ghost" }]] },
    ];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain('contact references unknown tag "ghost"');
  });

  it("flags an empty OR-path (rejected by the backend)", () => {
    const p = base();
    p.networks[0].rungs[0].series = [{ branch: [[{ type: "contact", tag: "a" }], []] }];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain("branch OR-path 2 is empty");
  });

  it("warns when a rung has no output", () => {
    const p = base();
    p.networks[0].rungs[0].coils = [];
    const issues = validateProgram(p);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].message).toContain("no output");
  });

  it("validates move and calc outputs", () => {
    const p = base();
    p.tags.r = { kind: "memory", type: "REAL" };
    p.networks[0].rungs[0].coils = [
      { type: "move", dst: "r", src: 5 },
      { type: "calc", op: "ADD", dst: "gone", a: "t", b: 2 },
    ];
    const msgs = validateProgram(p).map((i) => i.message);
    expect(msgs).toContain('calc target references unknown tag "gone"');
    // The valid move produces no message.
    expect(msgs.some((m) => m.startsWith("move"))).toBe(false);
  });
});
