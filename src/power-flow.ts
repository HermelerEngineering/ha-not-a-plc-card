/**
 * Pure "power flow" computation for the read-only monitor.
 *
 * Given the program IR and the latest process image, decide which elements are
 * *live* (power actually flows through them) so the card can colour them. This
 * is the frontend counterpart of the engine's `_eval_series` / `_eval_element`
 * and mirrors its semantics exactly:
 *
 *   - a contact conducts on its tag's truth (NO) or its negation (NC),
 *   - a series chain conducts when every position conducts (an empty chain
 *     conducts, matching the engine),
 *   - a parallel branch conducts when any of its paths conducts,
 *   - a NOT group conducts when its inner series does *not*.
 *
 * Kept free of any DOM or Lit imports so it is unit-testable in isolation — the
 * single most valuable frontend test asset (see project-plan §7).
 */

import {
  Coil,
  CompareEl,
  CompareOp,
  Element,
  Program,
  Rung,
  StateImage,
  isBranch,
  isCompare,
  isContact,
  isNot,
} from "./ir";

const COMPARATORS: Record<CompareOp, (a: number, b: number) => boolean> = {
  GT: (a, b) => a > b,
  GE: (a, b) => a >= b,
  LT: (a, b) => a < b,
  LE: (a, b) => a <= b,
  EQ: (a, b) => a === b,
  NE: (a, b) => a !== b,
};

function asNumber(value: boolean | number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function compareConducts(el: CompareEl, state: StateImage): boolean {
  const left = asNumber(state[el.left]);
  const right =
    typeof el.right === "number" ? el.right : asNumber(state[el.right]);
  if (left === null || right === null) return false;
  return COMPARATORS[el.op](left, right);
}

export interface ElementFlow {
  /** Does this element conduct on its own terms (ignoring upstream power)? */
  conducts: boolean;
  /** Does power actually reach *and* pass through this element? */
  live: boolean;
}

export interface CoilFlow {
  /** Is the rung feeding this coil energised (power reaches the coil)? */
  energised: boolean;
  /** The coil/memory tag's current stored value from the process image. */
  value: boolean;
}

export interface RungFlow {
  /** Does power reach the right rail (the coils)? */
  result: boolean;
}

export interface PowerFlow {
  elements: Map<Element, ElementFlow>;
  coils: Map<Coil, CoilFlow>;
  rungs: Map<Rung, RungFlow>;
}

export function truthy(value: boolean | number | undefined | null): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

function contactConducts(tag: string, mode: string | undefined, state: StateImage): boolean {
  const s = truthy(state[tag]);
  return mode === "NC" ? !s : s;
}

/** Whether an element conducts, ignoring upstream power (engine semantics). */
export function elementConducts(el: Element, state: StateImage): boolean {
  if (isContact(el)) return contactConducts(el.tag, el.mode, state);
  if (isCompare(el)) return compareConducts(el, state);
  if (isNot(el)) return !seriesConducts(el.not, state);
  return el.branch.some((path) => seriesConducts(path, state));
}

/** Whether a series chain conducts. An empty chain conducts (matches engine). */
export function seriesConducts(els: Element[], state: StateImage): boolean {
  return els.every((el) => elementConducts(el, state));
}

/** Annotate elements for display only: `live` mirrors their own conduct. */
function annotateInformational(
  els: Element[],
  state: StateImage,
  out: Map<Element, ElementFlow>,
): void {
  for (const el of els) {
    const conducts = elementConducts(el, state);
    out.set(el, { conducts, live: conducts });
    if (isNot(el)) {
      annotateInformational(el.not, state, out);
    } else if (isBranch(el)) {
      for (const path of el.branch) annotateInformational(path, state, out);
    }
  }
}

/** Propagate power through one element; return whether power leaves it live. */
function flowElement(
  el: Element,
  state: StateImage,
  poweredIn: boolean,
  out: Map<Element, ElementFlow>,
): boolean {
  const conducts = elementConducts(el, state);
  const live = poweredIn && conducts;
  out.set(el, { conducts, live });

  if (isBranch(el)) {
    // Each path receives the branch's incoming power; a path lights up as far
    // as power actually flows along it.
    for (const path of el.branch) flowSeries(path, state, poweredIn, out);
  } else if (isNot(el)) {
    // The negation itself carries the power; inner contacts are shown purely
    // as information (their own conduct), not as a power path.
    annotateInformational(el.not, state, out);
  }
  return live;
}

/** Propagate power along a series chain; return whether it reaches the end. */
function flowSeries(
  els: Element[],
  state: StateImage,
  poweredIn: boolean,
  out: Map<Element, ElementFlow>,
): boolean {
  let powered = poweredIn;
  for (const el of els) {
    powered = flowElement(el, state, powered, out);
  }
  return powered;
}

/**
 * Compute the full live/energised picture for a program against a state image.
 * The left rail is always powered, so a rung's result is whether power reaches
 * the coils on the right.
 */
export function computePowerFlow(program: Program, state: StateImage): PowerFlow {
  const elements = new Map<Element, ElementFlow>();
  const coils = new Map<Coil, CoilFlow>();
  const rungs = new Map<Rung, RungFlow>();

  for (const network of program.networks) {
    for (const rung of network.rungs) {
      const result = flowSeries(rung.series, state, true, elements);
      rungs.set(rung, { result });
      for (const coil of rung.coils) {
        coils.set(coil, { energised: result, value: truthy(state[coil.tag]) });
      }
    }
  }
  return { elements, coils, rungs };
}
