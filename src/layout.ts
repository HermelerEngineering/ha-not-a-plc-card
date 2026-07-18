/**
 * Pure grid layout of a ladder rung — no rendering, no lit, no DOM.
 *
 * A rung is measured in grid cells: the main series runs left to right along a
 * row; a branch stacks its OR-paths on successive rows sharing the same column
 * grid. `render.ts` turns these grid coordinates into pixels; the editor overlay
 * uses `walkSeries` to place hit-targets on elements at any depth. Kept separate
 * from `render.ts` so it can be unit-tested without importing lit.
 */

import { SeriesStep } from "./elements";
import { Element, isBranch, isCompare, isContact, isFb, isNot } from "./ir";

export interface Measure {
  cols: number;
  rows: number;
}

export function measureElement(el: Element): Measure {
  if (isContact(el)) return { cols: 1, rows: 1 };
  if (isCompare(el)) return { cols: 1, rows: 1 };
  // A function block is drawn as a TIA-style box with pins down both edges: two
  // columns wide (room for the setting/value labels beside the pins) and two
  // rows tall (the power pin on the baseline, parameter pins below).
  if (isFb(el)) return { cols: 2, rows: 2 };
  if (isNot(el)) return { cols: 1, rows: 1 };
  let cols = 1;
  let rows = 0;
  for (const path of el.branch) {
    const m = measureSeries(path);
    cols = Math.max(cols, m.cols);
    rows += m.rows;
  }
  return { cols, rows };
}

export function measureSeries(els: Element[]): Measure {
  let cols = 0;
  let rows = 1;
  for (const el of els) {
    const m = measureElement(el);
    cols += m.cols;
    rows = Math.max(rows, m.rows);
  }
  return { cols: Math.max(cols, 1), rows };
}

/** One element's grid cell, addressed by the `SeriesStep` path to its series. */
export interface ElementCell {
  steps: SeriesStep[];
  ei: number;
  col: number;
  row: number;
  cols: number;
  rows: number;
  el: Element;
}

/** One series' grid row and the columns of its insertion slots (n+1 entries). */
export interface SeriesInfo {
  steps: SeriesStep[];
  row: number;
  slotCols: number[];
}

export interface WalkResult {
  cells: ElementCell[];
  series: SeriesInfo[];
}

/**
 * Walk a rung's series and every nested branch path, yielding each element's
 * grid cell and each series' slot columns — the exact same layout the painter
 * uses (branches stack their paths on successive rows on the shared column
 * grid). The editor overlay turns these into hit-targets so elements inside
 * branches are selectable/insertable, addressed by their `SeriesStep` path.
 * A parent branch cell is emitted before its children, so drawing in order puts
 * child hit-targets on top.
 */
export function walkSeries(series: Element[]): WalkResult {
  const cells: ElementCell[] = [];
  const infos: SeriesInfo[] = [];
  const recur = (s: Element[], col: number, row: number, steps: SeriesStep[]): void => {
    const slotCols: number[] = [];
    let x = col;
    s.forEach((el, ei) => {
      slotCols.push(x);
      const m = measureElement(el);
      cells.push({ steps, ei, col: x, row, cols: m.cols, rows: m.rows, el });
      if (isBranch(el)) {
        let r = row;
        el.branch.forEach((path, pi) => {
          recur(path, x, r, [...steps, { index: ei, path: pi }]);
          r += measureSeries(path).rows;
        });
      }
      x += m.cols;
    });
    slotCols.push(x);
    infos.push({ steps, row, slotCols });
  };
  recur(series, 0, 0, []);
  return { cells, series: infos };
}

/** Whether two `SeriesStep` paths address the same series. */
export function sameSteps(a: SeriesStep[], b: SeriesStep[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.index === b[i].index && s.path === b[i].path)
  );
}
