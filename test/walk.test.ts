import { describe, expect, it } from "vitest";

import { Element } from "../src/ir";
import { walkSeries } from "../src/layout";

/** a — ( b | c d ) : a contact, then a branch with two OR-paths. */
function series(): Element[] {
  return [
    { type: "contact", tag: "a" },
    {
      branch: [
        [{ type: "contact", tag: "b" }],
        [
          { type: "contact", tag: "c" },
          { type: "contact", tag: "d" },
        ],
      ],
    },
  ];
}

describe("walkSeries", () => {
  it("emits a cell for every element at all depths, parent branch before its children", () => {
    const { cells } = walkSeries(series());
    // a, branch, b, c, d
    expect(cells).toHaveLength(5);
    expect(cells.map((c) => c.steps.length)).toEqual([0, 0, 1, 1, 1]);

    const [a, branch, b, c, d] = cells;
    expect(a).toMatchObject({ ei: 0, col: 0, row: 0, cols: 1, rows: 1 });
    // The branch is 2 cols wide (its widest path) and 2 rows tall (two paths).
    expect(branch).toMatchObject({ ei: 1, col: 1, row: 0, cols: 2, rows: 2 });

    // Path 0 sits on row 0 at the branch's start column; path 1 on row 1.
    expect(b).toMatchObject({ steps: [{ index: 1, path: 0 }], ei: 0, col: 1, row: 0 });
    expect(c).toMatchObject({ steps: [{ index: 1, path: 1 }], ei: 0, col: 1, row: 1 });
    expect(d).toMatchObject({ steps: [{ index: 1, path: 1 }], ei: 1, col: 2, row: 1 });
  });

  it("reports slot columns for every series (n+1 entries)", () => {
    const { series: infos } = walkSeries(series());
    const top = infos.find((s) => s.steps.length === 0);
    // before a (0), before the branch (1), after the branch (3).
    expect(top?.slotCols).toEqual([0, 1, 3]);

    const path1 = infos.find(
      (s) => s.steps.length === 1 && s.steps[0].path === 1,
    );
    expect(path1?.row).toBe(1);
    expect(path1?.slotCols).toEqual([1, 2, 3]);
  });

  it("returns only top-level entries for a flat series", () => {
    const { cells, series: infos } = walkSeries([
      { type: "contact", tag: "x" },
      { type: "contact", tag: "y" },
    ]);
    expect(cells.every((c) => c.steps.length === 0)).toBe(true);
    expect(infos).toHaveLength(1);
    expect(infos[0].slotCols).toEqual([0, 1, 2]);
  });
});
