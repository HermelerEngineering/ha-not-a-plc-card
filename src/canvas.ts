/**
 * Pure helpers for the click-to-place canvas editor (phase 4.4).
 *
 * The canvas renders each rung as a row of element *tiles* separated by clickable
 * *slots*; arming a palette tool and clicking a slot inserts an element there.
 * Only the presentation-neutral bits live here (a compact label per element and
 * the palette definition) so they can be unit-tested; the DOM wiring and the
 * actual IR edits (via `elements.ts`) live in the panel.
 */

import {
  CompareOp,
  Element,
  FunctionBlockDef,
  isBranch,
  isCompare,
  isContact,
  isFb,
  isNot,
} from "./ir";

const OP_SYMBOL: Record<CompareOp, string> = {
  GT: ">",
  GE: "≥",
  LT: "<",
  LE: "≤",
  EQ: "=",
  NE: "≠",
};

/** A short, ladder-flavoured label for an element tile. */
export function elementLabel(
  el: Element,
  fbs: Record<string, FunctionBlockDef> = {},
): string {
  if (isContact(el)) {
    const sym = el.mode === "NC" ? "]/[" : "] [";
    return `${sym} ${el.tag || "?"}`;
  }
  if (isCompare(el)) {
    return `[ ${el.left || "?"} ${OP_SYMBOL[el.op]} ${el.right} ]`;
  }
  if (isFb(el)) {
    const type = fbs[el.instance]?.type ?? "FB";
    return `${type} ${el.instance || "?"}`;
  }
  if (isNot(el)) return "NOT";
  if (isBranch(el)) return `OR (${el.branch.length})`;
  return "?";
}

/** Kind of thing a palette tool places. */
export type ToolTarget = "element" | "coil";
