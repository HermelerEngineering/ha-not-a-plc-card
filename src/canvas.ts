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

// --- pointer-drag reordering (phase 4.4 stage C) ---------------------------
//
// A rung's top-level series has n elements and n+1 *insertion slots* (before the
// first element, between each pair, and after the last). The renderer reports
// the x of each slot; these pure helpers turn a pointer x into a slot index and
// that slot into the positional delta `moveElementIn` expects.

/** Index of the insertion slot whose x is nearest the pointer x. */
export function nearestSlot(slotXs: number[], x: number): number {
  let best = 0;
  let bestDist = Infinity;
  slotXs.forEach((sx, i) => {
    const d = Math.abs(sx - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * The positional delta to pass `moveElementIn` to move the element at `ei` so it
 * lands at insertion slot `drop`. `moveItem` removes the element first, so a drop
 * to the right of its own position shifts the target index down by one. Dropping
 * onto its own two adjacent slots is a no-op (delta 0).
 */
export function reorderDelta(ei: number, drop: number): number {
  const target = drop <= ei ? drop : drop - 1;
  return target - ei;
}

/** A rung's interaction geometry within its network SVG (user-space units). */
export interface RungGeom {
  ri: number;
  top: number;
  bottom: number;
  slotXs: number[];
}

/**
 * Given a network's rung geometries and a pointer at (x, y) in that SVG's user
 * space, the rung the pointer is over and the nearest insertion slot in it —
 * used to drop a palette element onto the live view. Returns null when the
 * pointer is not over any rung's band.
 */
export function hitRung(
  geoms: RungGeom[],
  x: number,
  y: number,
): { ri: number; index: number } | null {
  const g = geoms.find((r) => y >= r.top && y <= r.bottom);
  if (!g) return null;
  return { ri: g.ri, index: nearestSlot(g.slotXs, x) };
}
