import { describe, expect, it } from "vitest";

import { blockPinRows, fbBlock, outputBlock } from "../src/block";

describe("fbBlock", () => {
  it("gives a timer IN/PT inputs and Q/ET outputs, power pins first", () => {
    const b = fbBlock("t1", { type: "TON", preset_ms: 5000 }, { "t1.ET": 1200 });
    expect(b.title).toBe("TON");
    expect(b.ins.map((p) => p.label)).toEqual(["IN", "PT"]);
    expect(b.outs.map((p) => p.label)).toEqual(["Q", "ET"]);
    expect(b.ins[0].power).toBe(true);
    expect(b.outs[0].power).toBe(true);
    // Setting on the PT input, live value on the ET output.
    expect(b.ins[1].value).toBe("5000ms");
    expect(b.outs[1].value).toBe("1200");
    expect(blockPinRows(b)).toBe(2);
  });

  it("falls back to 0 for a live output before the first state push", () => {
    const b = fbBlock("t1", { type: "TON", preset_ms: 1000 }, {});
    expect(b.outs[1].value).toBe("0");
  });

  it("shows a counter's reset tag, PV setting and live CV", () => {
    const b = fbBlock("c1", { type: "CTU", pv: 3, reset: "clr" }, { "c1.CV": 2 });
    expect(b.ins.map((p) => p.label)).toEqual(["CU", "R", "PV"]);
    expect(b.ins[1].value).toBe("clr");
    expect(b.ins[2].value).toBe("3");
    expect(b.outs.map((p) => p.label)).toEqual(["Q", "CV"]);
    expect(b.outs[1].value).toBe("2");
    expect(blockPinRows(b)).toBe(3);
  });

  it("marks an unbound optional input with an em dash", () => {
    const b = fbBlock("c1", { type: "CTU", pv: 1 }, {});
    expect(b.ins[1].value).toBe("—"); // no reset bound
  });

  it("gives a latch a set (power) and a reset tag", () => {
    const b = fbBlock("l1", { type: "SR", reset: "r" }, {});
    expect(b.ins.map((p) => p.label)).toEqual(["S", "R"]);
    expect(b.ins[1].value).toBe("r");
    expect(b.outs.map((p) => p.label)).toEqual(["Q"]);
    expect(blockPinRows(b)).toBe(2);
  });

  it("gives an edge a single power in/out (one pin row)", () => {
    const b = fbBlock("e1", { type: "R_TRIG" }, {});
    expect(b.ins.map((p) => p.label)).toEqual(["CLK"]);
    expect(b.outs.map((p) => p.label)).toEqual(["Q"]);
    expect(blockPinRows(b)).toBe(1);
  });

  it("labels an unknown/undefined block as FB with one power pin row", () => {
    expect(fbBlock("x", undefined, {}).title).toBe("FB");
    expect(blockPinRows(fbBlock("x", undefined, {}))).toBe(1);
  });
});

describe("outputBlock", () => {
  it("gives a move one IN input and an OUT output with live values", () => {
    const b = outputBlock(
      { type: "move", dst: "level", src: "raw" },
      { raw: 12.5, level: 12.5 },
    );
    expect(b.title).toBe("MOVE");
    expect(b.ins.map((p) => p.label)).toEqual(["IN"]);
    expect(b.ins[0].value).toBe("raw=12.5");
    expect(b.outs[0].label).toBe("OUT");
    expect(b.outs[0].value).toBe("level=12.5");
    expect(blockPinRows(b)).toBe(1);
  });

  it("shows a numeric move source verbatim", () => {
    const b = outputBlock({ type: "move", dst: "sp", src: 21 }, {});
    expect(b.ins[0].value).toBe("21");
  });

  it("gives a calc two inputs titled by its operator", () => {
    const b = outputBlock(
      { type: "calc", op: "ADD", dst: "out", a: "x", b: 5 },
      { x: 3, out: 8 },
    );
    expect(b.title).toBe("ADD");
    expect(b.ins.map((p) => p.label)).toEqual(["IN1", "IN2"]);
    expect(b.ins[0].value).toBe("x=3");
    expect(b.ins[1].value).toBe("5");
    expect(b.outs[0].value).toBe("out=8");
    expect(blockPinRows(b)).toBe(2);
  });
});
