/**
 * Pure helpers for editing the *structure* of a program (phase 4.3):
 * networks, rungs, series elements (including nested branch / NOT groups) and
 * coils.
 *
 * Like `tags.ts` these are side-effect free and unit-tested with vitest; the
 * panel wires them to forms. They operate immutably (always returning a new
 * `Program`) and address targets by index: `ni` = network index, `ri` = rung
 * index within that network, `ei`/`ci` = element/coil index. A nested series is
 * addressed by a `SeriesStep[]` path from the rung's top-level series (empty for
 * the top level); the top-level `addElement`/… helpers are thin wrappers over the
 * path-based `addElementIn`/… with an empty path.
 */

import {
  BranchEl,
  CalcEl,
  CalcOp,
  Coil,
  CoilMode,
  CompareEl,
  CompareOp,
  ContactEl,
  ContactMode,
  Element,
  FbRefEl,
  MoveEl,
  Network,
  NotEl,
  Output,
  Program,
  Rung,
  isBranch,
} from "./ir";

// --- immutable array helpers ------------------------------------------------

function mapAt<T>(arr: T[], i: number, fn: (item: T) => T): T[] {
  return arr.map((item, idx) => (idx === i ? fn(item) : item));
}

function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, idx) => idx !== i);
}

function moveItem<T>(arr: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(i, 1);
  next.splice(j, 0, item);
  return next;
}

/** The lowest-numbered fresh `<prefix><n>` id (n≥1) not present in `existing`. */
export function freshId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// --- constructors -----------------------------------------------------------

export function newContact(tag = "", mode: ContactMode = "NO"): ContactEl {
  return { type: "contact", tag, mode };
}

export function newCompare(
  left = "",
  op: CompareOp = "GT",
  right: number | string = 0,
): CompareEl {
  return { type: "compare", op, left, right };
}

export function newFbRef(instance = ""): FbRefEl {
  return { type: "fb", instance };
}

export function newCoil(tag = "", mode: CoilMode = "="): Coil {
  return { type: "coil", tag, mode };
}

export function newMove(dst = "", src: number | string = 0): MoveEl {
  return { type: "move", dst, src };
}

export function newCalc(op: CalcOp = "ADD"): CalcEl {
  return { type: "calc", op, dst: "", a: 0, b: 0 };
}

export function newRung(id: string): Rung {
  return { id, series: [], coils: [] };
}

export function newNetwork(id: string, rungId: string): Network {
  return { id, rungs: [newRung(rungId)] };
}

// --- network ops ------------------------------------------------------------

function withNetworks(program: Program, networks: Network[]): Program {
  return { ...program, networks };
}

export function addNetwork(program: Program): Program {
  const id = freshId(
    program.networks.map((n) => n.id),
    "n",
  );
  return withNetworks(program, [...program.networks, newNetwork(id, "r1")]);
}

export function removeNetwork(program: Program, ni: number): Program {
  return withNetworks(program, removeAt(program.networks, ni));
}

export function moveNetwork(program: Program, ni: number, delta: number): Program {
  return withNetworks(program, moveItem(program.networks, ni, delta));
}

export function setNetworkTitle(program: Program, ni: number, title: string): Program {
  return withNetworks(
    program,
    mapAt(program.networks, ni, (n) => ({ ...n, title: title || undefined })),
  );
}

// --- rung ops ---------------------------------------------------------------

function withRungs(program: Program, ni: number, rungs: Rung[]): Program {
  return withNetworks(program, mapAt(program.networks, ni, (n) => ({ ...n, rungs })));
}

export function addRung(program: Program, ni: number): Program {
  const net = program.networks[ni];
  if (!net) return program;
  const id = freshId(
    net.rungs.map((r) => r.id),
    "r",
  );
  return withRungs(program, ni, [...net.rungs, newRung(id)]);
}

export function removeRung(program: Program, ni: number, ri: number): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(program, ni, removeAt(net.rungs, ri));
}

export function moveRung(
  program: Program,
  ni: number,
  ri: number,
  delta: number,
): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(program, ni, moveItem(net.rungs, ri, delta));
}

export function setRungTitle(
  program: Program,
  ni: number,
  ri: number,
  title: string,
): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(
    program,
    ni,
    mapAt(net.rungs, ri, (r) => ({ ...r, title: title || undefined })),
  );
}

// --- element + coil ops (top level of a rung's series) ----------------------

function updateRungAt(
  program: Program,
  ni: number,
  ri: number,
  fn: (rung: Rung) => Rung,
): Program {
  const net = program.networks[ni];
  if (!net || !net.rungs[ri]) return program;
  return withRungs(program, ni, mapAt(net.rungs, ri, fn));
}

/**
 * One hop into a nested series: `index` selects a branch element in the current
 * series, `path` its OR-path. A `SeriesStep[]` addresses a series array reachable
 * from the rung's top-level series (an empty array = top level). NOT is now an
 * inline leaf (not a container), so branches are the only nesting.
 */
export interface SeriesStep {
  index: number;
  path: number;
}

/** Rewrite the series array located at `steps` (from the rung's top series). */
function mapSeriesAt(
  series: Element[],
  steps: SeriesStep[],
  fn: (s: Element[]) => Element[],
): Element[] {
  if (steps.length === 0) return fn(series);
  const [step, ...rest] = steps;
  return series.map((el, i) => {
    if (i !== step.index || !isBranch(el)) return el;
    return {
      branch: el.branch.map((p, pi) =>
        pi === step.path ? mapSeriesAt(p, rest, fn) : p,
      ),
    };
  });
}

function editSeriesAt(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  fn: (s: Element[]) => Element[],
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    series: mapSeriesAt(r.series, steps, fn),
  }));
}

export function addElementIn(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  el: Element,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) => [...s, el]);
}

/** Insert an element at position `index` in the series at `steps`. */
export function insertElementIn(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  index: number,
  el: Element,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) => [
    ...s.slice(0, index),
    el,
    ...s.slice(index),
  ]);
}

export function removeElementIn(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) => removeAt(s, ei));
}

export function updateElementIn(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
  el: Element,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) => mapAt(s, ei, () => el));
}

export function moveElementIn(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
  delta: number,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) => moveItem(s, ei, delta));
}

/** The element addressed by (steps, ei) in a rung, or undefined. */
export function elementAt(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
): Element | undefined {
  let series = program.networks[ni]?.rungs[ri]?.series;
  for (const step of steps) {
    const el = series?.[step.index];
    if (!el || !isBranch(el)) return undefined;
    series = el.branch[step.path];
  }
  return series?.[ei];
}

function stepsEqual(a: SeriesStep[], b: SeriesStep[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.index === b[i].index && s.path === b[i].path)
  );
}

/** Whether `pre` is a strict (shorter) prefix of `full`. */
function isStrictPrefix(pre: SeriesStep[], full: SeriesStep[]): boolean {
  return (
    pre.length < full.length &&
    pre.every((s, i) => s.index === full[i].index && s.path === full[i].path)
  );
}

/**
 * Move the element at (from.steps, from.ei) to insertion slot (to.steps, to.index)
 * within one rung — the drag-into/within-a-branch operation. The source is removed
 * first, so the target index/path is corrected for that shift; dropping an element
 * into itself is refused. A move within one series reduces to a reorder.
 */
export function moveElementAcross(
  program: Program,
  ni: number,
  ri: number,
  from: { steps: SeriesStep[]; ei: number },
  to: { steps: SeriesStep[]; index: number },
): Program {
  const el = elementAt(program, ni, ri, from.steps, from.ei);
  if (!el) return program;

  let steps = to.steps;
  let index = to.index;
  const L = from.steps.length;
  if (stepsEqual(from.steps, to.steps)) {
    // Same series: after removing from.ei, later slots shift down by one.
    if (index > from.ei) index -= 1;
  } else if (isStrictPrefix(from.steps, to.steps)) {
    // The target is inside a branch of the source series; its L-th step indexes
    // that source series. A target inside the moved element itself is invalid.
    const nextIdx = to.steps[L].index;
    if (nextIdx === from.ei) return program;
    if (nextIdx > from.ei) {
      steps = to.steps.map((s, i) => (i === L ? { ...s, index: s.index - 1 } : s));
    }
  }
  // Otherwise the target series is unrelated (or an ancestor) — no shift.

  const removed = removeElementIn(program, ni, ri, from.steps, from.ei);
  return insertElementIn(removed, ni, ri, steps, index, el);
}

// Top-level convenience wrappers (steps = []).
export function addElement(
  program: Program,
  ni: number,
  ri: number,
  el: Element,
): Program {
  return addElementIn(program, ni, ri, [], el);
}

export function removeElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
): Program {
  return removeElementIn(program, ni, ri, [], ei);
}

export function updateElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
  el: Element,
): Program {
  return updateElementIn(program, ni, ri, [], ei, el);
}

export function moveElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
  delta: number,
): Program {
  return moveElementIn(program, ni, ri, [], ei, delta);
}

export function newBranch(): BranchEl {
  return { branch: [[], []] };
}

/**
 * Replace the element at (steps, ei) with an OR branch: the element in the first
 * path and a second, empty path ready to fill — "wrap the selection in an OR
 * branch". The empty path is what makes it an actual OR (the user fills it via its
 * insert slots; validation flags it as empty until then). A branch is left
 * unchanged (wrapping a branch in a branch is not useful).
 */
export function wrapInBranch(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) =>
    mapAt(s, ei, (el) => (isBranch(el) ? el : { branch: [[el], []] })),
  );
}

/**
 * Append an OR-path (default empty) to the branch element at `ei` in the series
 * addressed by `steps`. A no-op if that element is not a branch.
 */
export function addBranchPath(
  program: Program,
  ni: number,
  ri: number,
  steps: SeriesStep[],
  ei: number,
  path: Element[] = [],
): Program {
  return editSeriesAt(program, ni, ri, steps, (s) =>
    mapAt(s, ei, (el) => (isBranch(el) ? { branch: [...el.branch, path] } : el)),
  );
}

export function newNot(): NotEl {
  return { type: "not" };
}

export function addCoil(
  program: Program,
  ni: number,
  ri: number,
  output: Output,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({ ...r, coils: [...r.coils, output] }));
}

/** Insert an output at position `index` in the rung's output list. */
export function insertCoil(
  program: Program,
  ni: number,
  ri: number,
  index: number,
  output: Output,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    coils: [...r.coils.slice(0, index), output, ...r.coils.slice(index)],
  }));
}

export function removeCoil(
  program: Program,
  ni: number,
  ri: number,
  ci: number,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({ ...r, coils: removeAt(r.coils, ci) }));
}

export function updateCoil(
  program: Program,
  ni: number,
  ri: number,
  ci: number,
  output: Output,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    coils: mapAt(r.coils, ci, () => output),
  }));
}
