/**
 * Pure helpers for the click-to-place canvas editor (phase 4.4).
 *
 * The canvas renders each rung as a row of element *tiles* separated by clickable
 * *slots*; arming a palette tool and clicking a slot inserts an element there.
 * Only the presentation-neutral bits live here (a compact label per element and
 * the palette definition) so they can be unit-tested; the DOM wiring and the
 * actual IR edits (via `elements.ts`) live in the panel.
 */

import { SeriesStep } from "./elements";
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

/**
 * The gap index (0..count) a rung would drop into for a pointer at user-y `y`,
 * given each rung's vertical band. Above every band → 0; below every band →
 * count; within a band → before or after that rung by its midpoint. Used to
 * reorder rungs by dragging.
 */
export function rungDropGap(
  bands: { ri: number; top: number; bottom: number }[],
  y: number,
): number {
  const sorted = [...bands].sort((a, b) => a.top - b.top);
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (y <= b.bottom) {
      // At or above this band: before it (gap i) if above its midpoint, else
      // after it (gap i + 1). Gaps are ordinal positions among the rungs.
      return y < (b.top + b.bottom) / 2 ? i : i + 1;
    }
  }
  return sorted.length; // below the last band
}

/** A rung's interaction geometry within its network SVG (user-space units). */
export interface RungGeom {
  ri: number;
  top: number;
  bottom: number;
  /** Top-level insertion-slot x-positions (reorder + coil geometry). */
  slotXs: number[];
  /** Every insertion slot (top-level + nested) as a palette drop target. */
  targets: SlotTarget[];
  /** Each output's vertical band in the coil column (for drag-reorder). */
  coilBands?: CoilBand[];
}

/** One output's vertical band in a rung's coil column (user-space y). */
export interface CoilBand {
  ci: number;
  top: number;
  bottom: number;
}

/** One insertion slot as a palette-drag drop target, in a rung's SVG space. */
export interface SlotTarget {
  steps: SeriesStep[];
  index: number;
  x: number;
  top: number;
  bottom: number;
}

/** A drop target flattened with its rung index (for cross-rung resolution). */
export interface RungDropTarget extends SlotTarget {
  ri: number;
}

/**
 * The insertion slot nearest a pointer at (x, y): among the slots whose vertical
 * band contains y, the one with the smallest horizontal distance; deeper
 * (more-nested) slots win exact ties so a drop at a branch entry lands inside.
 * Returns null when y is over no slot's band (e.g. an inter-rung gap), so a drop
 * there places nothing.
 */
export function nearestTarget(
  targets: RungDropTarget[],
  x: number,
  y: number,
): RungDropTarget | null {
  let best: RungDropTarget | null = null;
  let bestScore = Infinity;
  for (const t of targets) {
    if (y < t.top || y > t.bottom) continue;
    const score = Math.abs(t.x - x) - t.steps.length * 0.001;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Given a network's rung geometries and a pointer at (x, y) in that SVG's user
 * space, the rung the pointer is over and the nearest insertion slot in it —
 * used to drop a palette element onto the live view. Returns null when the
 * pointer is not over any rung's band.
 *
 * `padBottom` extends each rung's match zone downward (into the gap before the
 * next rung). Coil drops pass the inter-rung gap here so a drop aimed at the
 * append slot below a tall coil stack still resolves to that rung; element drops
 * pass 0 so a drop in the gap places nothing.
 */
export function hitRung(
  geoms: RungGeom[],
  x: number,
  y: number,
  padBottom = 0,
): { ri: number; index: number } | null {
  const g = geoms.find((r) => y >= r.top && y <= r.bottom + padBottom);
  if (!g) return null;
  return { ri: g.ri, index: nearestSlot(g.slotXs, x) };
}
