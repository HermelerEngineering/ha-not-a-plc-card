/**
 * SVG rendering of a ladder program, coloured by live power flow.
 *
 * Layout is a simple grid: the main series of a rung runs along a baseline row;
 * parallel branches hang below it. Everything is measured in grid cells first,
 * then drawn to pixels. Colours come from CSS custom properties so the card
 * follows the Home Assistant theme.
 *
 * This module owns only presentation; all truth about what is energised comes
 * from `computePowerFlow` (see power-flow.ts). Condition *symbols* (contacts,
 * compares) are coloured by their own conduct state, so a satisfied condition
 * shows even when an upstream break stopped power reaching it; the *wires* between
 * elements follow actual power flow, so the line still visibly stops at the break.
 */

import { SVGTemplateResult, svg } from "lit";

import {
  BranchEl,
  CompareEl,
  CompareOp,
  ContactEl,
  Element,
  FbRefEl,
  FunctionBlockDef,
  Network,
  NotEl,
  Rung,
  StateImage,
  isBranch,
  isCalc,
  isCompare,
  isContact,
  isFb,
  isMove,
  isNot,
} from "./ir";
import { blockPinRows, fbBlock, outputBlock } from "./block";
import { SlotTarget } from "./canvas";
import { SeriesStep } from "./elements";
import {
  SeriesInfo,
  measureElement,
  measureSeries,
  sameSteps,
  walkSeries,
} from "./layout";
import { PowerFlow } from "./power-flow";

const OP_SYMBOL: Record<CompareOp, string> = {
  GT: ">",
  GE: "≥",
  LT: "<",
  LE: "≤",
  EQ: "=",
  NE: "≠",
};

/** Format a live process-image value for display, or null if not a number. */
function fmtNumber(value: boolean | number | undefined): string | null {
  if (typeof value !== "number") return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const CELL_W = 88;
const CELL_H = 56;
const PAD = 14;
const TITLE_H = 22;
const RAIL_W = 10;
const SYMBOL_HALF = 9;
/** Vertical gap between stacked rungs in a network. */
export const RUNG_GAP = 12;
/** Horizontal step between insert slots that would otherwise overlap (px). */
const SLOT_SPREAD = 15;
/** Vertical gap between a function block's stacked pins (px). */
const PIN_GAP = 20;
/** Vertical gap between a coil-column output block's stacked pins (px). */
const OUT_PIN_GAP = 18;
/** Right-hand space reserved for a rung with a REAL output block (move/calc). */
const OUTPUT_BLOCK_SPACE = 214;

/** Pixel X of the left edge of grid column `col` within a rung. */
function colX(col: number): number {
  return PAD + RAIL_W + col * CELL_W;
}

/** Pixel Y of the centre line of grid row `row` within a rung. */
function rowY(baseY: number, row: number): number {
  return baseY + row * CELL_H + CELL_H / 2;
}

function wireClass(powered: boolean): string {
  return powered ? "wire live" : "wire";
}

interface DrawResult {
  endCol: number;
  poweredOut: boolean;
}

class RungPainter {
  readonly parts: SVGTemplateResult[] = [];

  constructor(
    private readonly baseY: number,
    private readonly flow: PowerFlow,
    private readonly fbs: Record<string, FunctionBlockDef>,
    private readonly state: StateImage,
  ) {}

  private line(x1: number, y1: number, x2: number, y2: number, powered: boolean): void {
    this.parts.push(
      svg`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} class=${wireClass(powered)} />`,
    );
  }

  private label(x: number, y: number, text: string, cls: string): void {
    this.parts.push(svg`<text x=${x} y=${y} class=${cls}>${text}</text>`);
  }

  drawSeries(els: Element[], col: number, row: number, powered: boolean): DrawResult {
    let x = col;
    let live = powered;
    for (const el of els) {
      const res = this.drawElement(el, x, row, live);
      x = res.endCol;
      live = res.poweredOut;
    }
    return { endCol: x, poweredOut: live };
  }

  private drawElement(el: Element, col: number, row: number, powered: boolean): DrawResult {
    if (isContact(el)) return this.drawContact(el, col, row, powered);
    if (isCompare(el)) return this.drawCompare(el, col, row, powered);
    if (isFb(el)) return this.drawFb(el, col, row, powered);
    if (isNot(el)) return this.drawNot(el, col, row, powered);
    return this.drawBranch(el, col, row, powered);
  }

  private drawFb(
    el: FbRefEl,
    col: number,
    row: number,
    powered: boolean,
  ): DrawResult {
    const flow = this.flow.elements.get(el);
    const live = flow?.live ?? false;
    const m = measureElement(el);
    const y = rowY(this.baseY, row); // baseline = the power-pin row
    const left = colX(col);
    const right = colX(col + m.cols);
    const cx = (left + right) / 2;
    const def = this.fbs[el.instance];
    const layout = fbBlock(el.instance, def, this.state);
    const pinRows = blockPinRows(layout);
    const cls = live ? "symbol live" : "symbol";

    // Edges / power-only blocks: a compact box centred on the baseline, like NOT.
    if (pinRows === 1) {
      const boxW = 54;
      const boxH = 30;
      this.line(left, y, cx - boxW / 2, y, powered);
      this.line(cx + boxW / 2, y, right, y, live);
      this.parts.push(
        svg`<rect x=${cx - boxW / 2} y=${y - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
      );
      this.label(cx, y - boxH / 2 - 4, el.instance, "tag");
      this.label(cx, y + 4, layout.title, "fb-text");
      return { endCol: col + m.cols, poweredOut: live };
    }

    // TIA-style: a taller box with input pins left, output pins right. The power
    // pins sit on the baseline (row 0); parameter pins stack below it.
    const boxW = 60;
    const boxLeft = cx - boxW / 2;
    const boxRight = cx + boxW / 2;
    const boxTop = y - 16;
    const boxBottom = y + (pinRows - 1) * PIN_GAP + 12;

    // Power in/out wires along the baseline.
    this.line(left, y, boxLeft, y, powered);
    this.line(boxRight, y, right, y, live);

    this.parts.push(
      svg`<rect x=${boxLeft} y=${boxTop} width=${boxW} height=${boxBottom - boxTop} rx="3" class=${cls} fill="none" />`,
    );
    // Instance name above the box, block type inside its top.
    this.label(cx, boxTop - 4, el.instance, "tag");
    this.label(cx, boxTop + 13, layout.title, "fb-text");

    layout.ins.forEach((pin, i) => {
      const py = y + i * PIN_GAP;
      this.parts.push(
        svg`<text x=${boxLeft + 5} y=${py + 4} class="pin-l">${pin.label}</text>`,
      );
      if (!pin.power && pin.value !== undefined) {
        this.line(boxLeft - 12, py, boxLeft, py, false);
        this.parts.push(
          svg`<text x=${boxLeft - 14} y=${py + 4} class="pin-v-l">${pin.value}</text>`,
        );
      }
    });
    layout.outs.forEach((pin, i) => {
      const py = y + i * PIN_GAP;
      this.parts.push(
        svg`<text x=${boxRight - 5} y=${py + 4} class="pin-r">${pin.label}</text>`,
      );
      if (!pin.power && pin.value !== undefined) {
        this.line(boxRight, py, boxRight + 12, py, false);
        this.parts.push(
          svg`<text x=${boxRight + 14} y=${py + 4} class="pin-v-r">${pin.value}</text>`,
        );
      }
    });
    return { endCol: col + m.cols, poweredOut: live };
  }

  private drawCompare(
    el: CompareEl,
    col: number,
    row: number,
    powered: boolean,
  ): DrawResult {
    const flow = this.flow.elements.get(el);
    const live = flow?.live ?? false;
    const conducts = flow?.conducts ?? false;
    const y = rowY(this.baseY, row);
    const left = colX(col);
    const right = colX(col + 1);
    const mid = (left + right) / 2;
    const boxW = 58;
    const boxH = 26;

    this.line(left, y, mid - boxW / 2, y, powered);
    this.line(mid + boxW / 2, y, right, y, live);

    // Box coloured by the comparison's own truth (see drawContact), wires by power.
    const cls = conducts ? "symbol live" : "symbol";
    this.parts.push(
      svg`<rect x=${mid - boxW / 2} y=${y - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
    );
    // Left operand (with its live value) above; operator + right operand inside.
    const leftVal = fmtNumber(this.state[el.left]);
    const leftLabel = leftVal !== null ? `${el.left} = ${leftVal}` : el.left;
    this.label(mid, y - 20, leftLabel, "tag");
    let rightLabel = String(el.right);
    if (typeof el.right === "string") {
      const rv = fmtNumber(this.state[el.right]);
      if (rv !== null) rightLabel = `${el.right}=${rv}`;
    }
    this.label(mid, y + 4, `${OP_SYMBOL[el.op]} ${rightLabel}`, "compare-text");
    return { endCol: col + 1, poweredOut: live };
  }

  private drawContact(
    el: ContactEl,
    col: number,
    row: number,
    powered: boolean,
  ): DrawResult {
    const flow = this.flow.elements.get(el);
    const live = flow?.live ?? false;
    const conducts = flow?.conducts ?? false;
    const y = rowY(this.baseY, row);
    const left = colX(col);
    const right = colX(col + 1);
    const mid = (left + right) / 2;

    // Wires: incoming coloured by upstream power, outgoing by this element's flow.
    this.line(left, y, mid - SYMBOL_HALF, y, powered);
    this.line(mid + SYMBOL_HALF, y, right, y, live);

    // The *symbol* is coloured by the contact's own conduct (its condition is
    // satisfied), independent of whether power reached it — so you can see which
    // conditions are already met even after an upstream contact broke the line.
    const cls = conducts ? "symbol live" : "symbol";
    this.parts.push(
      svg`<line x1=${mid - SYMBOL_HALF} y1=${y - 11} x2=${mid - SYMBOL_HALF} y2=${y + 11} class=${cls} />`,
    );
    this.parts.push(
      svg`<line x1=${mid + SYMBOL_HALF} y1=${y - 11} x2=${mid + SYMBOL_HALF} y2=${y + 11} class=${cls} />`,
    );
    if (el.mode === "NC") {
      this.parts.push(
        svg`<line x1=${mid - SYMBOL_HALF - 2} y1=${y + 12} x2=${mid + SYMBOL_HALF + 2} y2=${y - 12} class=${cls} />`,
      );
    }
    this.label(mid, y - 18, el.tag, "tag");
    this.label(mid, y + 24, el.mode ?? "NO", "mode");
    return { endCol: col + 1, poweredOut: live };
  }

  private drawNot(el: NotEl, col: number, row: number, powered: boolean): DrawResult {
    // Inline inverter: a small box whose output (live) is the negated input.
    const flow = this.flow.elements.get(el);
    const live = flow?.live ?? false;
    const y = rowY(this.baseY, row);
    const left = colX(col);
    const right = colX(col + 1);
    const mid = (left + right) / 2;
    const boxW = 40;
    const boxH = 24;

    this.line(left, y, mid - boxW / 2, y, powered);
    this.line(mid + boxW / 2, y, right, y, live);

    const cls = live ? "symbol live" : "symbol";
    this.parts.push(
      svg`<rect x=${mid - boxW / 2} y=${y - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
    );
    this.label(mid, y + 4, "NOT", "fb-text");
    return { endCol: col + 1, poweredOut: live };
  }

  private drawBranch(el: BranchEl, col: number, row: number, powered: boolean): DrawResult {
    const paths = el.branch;
    const measure = measureElement(el);
    const endCol = col + measure.cols;
    const flow = this.flow.elements.get(el);
    const branchLive = flow?.live ?? false;

    const rowYs: number[] = [];
    let r = row;
    let anyLive = false;
    for (const path of paths) {
      const py = rowY(this.baseY, r);
      rowYs.push(py);
      const res = this.drawSeries(path, col, r, powered);
      // Pad the path with a straight wire out to the shared exit column.
      if (res.endCol < endCol) {
        this.line(colX(res.endCol), py, colX(endCol), py, res.poweredOut);
      }
      anyLive = anyLive || res.poweredOut;
      r += measureSeries(path).rows;
    }

    // Vertical buses at entry and exit connecting all path rows.
    const top = rowYs[0];
    const bottom = rowYs[rowYs.length - 1];
    this.line(colX(col), top, colX(col), bottom, powered);
    this.line(colX(endCol), top, colX(endCol), bottom, anyLive && branchLive);
    return { endCol, poweredOut: branchLive };
  }
}

/**
 * Optional interaction layer for the editor. When passed to `renderNetwork`, the
 * renderer draws transparent hit-targets over the ladder — element/coil select
 * boxes and (when a tool is armed) insertion slots — wired to these callbacks. The
 * read-only card passes no `edit`, so its rendering is byte-for-byte unchanged.
 */
export interface CanvasEdit {
  ni: number;
  /** What the armed palette tool places, or null in "select" mode. */
  armed: "element" | "coil" | null;
  selected?:
    | { kind: "el"; ni: number; ri: number; steps: SeriesStep[]; ei: number }
    | { kind: "coil"; ni: number; ri: number; ci: number };
  /** The in-progress top-level element drag in this network, or null. */
  drag?: { ri: number; ei: number; drop: number } | null;
  /** Which insertion slot a palette element being dragged in would drop into. */
  placeDrop?: { ri: number; steps: SeriesStep[]; index: number } | null;
  /**
   * Show insertion slots *inside* branches. True only for a persistently armed
   * element tool (click-to-place), not a palette drag — a drag resolves to the
   * top level only, so nested slots would be misleading.
   */
  allowNestedInsert?: boolean;
  onInsertElement: (ri: number, steps: SeriesStep[], index: number) => void;
  /** Select an element for the inspector (steps = [] for a top-level element). */
  onSelectElement: (ri: number, steps: SeriesStep[], ei: number) => void;
  /** Add a new OR-path to the branch at `ei` in the series at `steps`. */
  onAddPath?: (ri: number, steps: SeriesStep[], ei: number) => void;
  onInsertCoil: (ri: number, index: number) => void;
  onSelectCoil: (ri: number, ci: number) => void;
  /** Reports a rung's y-band, top-level slot x's, and all drop targets. */
  onGeometry?: (
    ri: number,
    geom: { top: number; bottom: number; slotXs: number[]; targets: SlotTarget[] },
  ) => void;
  /**
   * A pointer went down on a top-level element hit-target. The panel decides
   * whether it becomes a drag (moved) or a select (released in place).
   */
  onElementPointerDown?: (ri: number, ei: number, ev: PointerEvent) => void;
}

function renderRung(
  rung: Rung,
  baseY: number,
  flow: PowerFlow,
  width: number,
  fbs: Record<string, FunctionBlockDef>,
  state: StateImage,
  edit?: CanvasEdit,
  ri = 0,
): { part: SVGTemplateResult; height: number } {
  const measure = measureSeries(rung.series);
  // The rung is as tall as its widest need: the series' branch rows or, when
  // there are several coils, the stacked coil rows (first coil on the baseline,
  // extra coils below like parallel branch paths).
  const rows = Math.max(measure.rows, rung.coils.length);
  const painter = new RungPainter(baseY, flow, fbs, state);
  const baselineY = rowY(baseY, 0);

  // Left rail is always powered; draw it and a live stub that connects the rail
  // to the first element (no gap between the rail and the energised wire).
  painter.parts.push(
    svg`<line x1=${PAD} y1=${baseY} x2=${PAD} y2=${baseY + rows * CELL_H} class="rail" />`,
  );
  painter.parts.push(
    svg`<line x1=${PAD} y1=${baselineY} x2=${colX(0)} y2=${baselineY} class="wire live" />`,
  );
  const res = painter.drawSeries(rung.series, 0, 0, true);

  // Wire from the last element to the coils on the right, then the coils. A
  // move/calc output draws a wider TIA-style box, so reserve more room on the
  // right for those rungs.
  const hasOutputBlock = rung.coils.some((o) => isMove(o) || isCalc(o));
  const rightSpace = hasOutputBlock ? OUTPUT_BLOCK_SPACE : 120;
  const coilX = Math.max(colX(res.endCol) + 24, width - rightSpace);
  painter.parts.push(
    svg`<line x1=${colX(res.endCol)} y1=${baselineY} x2=${coilX} y2=${baselineY} class=${wireClass(res.poweredOut)} />`,
  );
  // Vertical bus down the coil column so stacked coils share the rung's power.
  if (rung.coils.length > 1) {
    const busBottom = baselineY + (rung.coils.length - 1) * CELL_H;
    painter.parts.push(
      svg`<line x1=${coilX} y1=${baselineY} x2=${coilX} y2=${busBottom} class=${wireClass(res.poweredOut)} />`,
    );
  }
  rung.coils.forEach((output, i) => {
    const cf = flow.coils.get(output);
    const energised = cf?.energised ?? false;
    const cy = baselineY + i * CELL_H;
    // Sit the output about half a cell right of the bus, so the stub matches the
    // spacing used between a branch bus and its parallel contacts.
    const cx = coilX + CELL_W / 2;

    if (isMove(output) || isCalc(output)) {
      // TIA-style output box: operand inputs on the left, destination on the
      // right, enable (the rung result) into the top-left corner. Same face as a
      // function block (see block.ts), coloured by whether the rung energised it.
      const layout = outputBlock(output, state);
      const pinRows = blockPinRows(layout);
      const cls = energised ? "symbol live" : "symbol";
      const boxW = 56;
      const boxLeft = coilX + 76;
      const boxRight = boxLeft + boxW;
      const boxCx = (boxLeft + boxRight) / 2;
      // Pins are centred vertically on the coil row so the box fits its height.
      const pinY = (idx: number) => cy + (idx - (pinRows - 1) / 2) * OUT_PIN_GAP;
      const boxTop = pinY(0) - 14;
      const boxBottom = pinY(pinRows - 1) + 14;

      // Enable wire: from the coil tap up the bus, then into the top-left corner.
      painter.parts.push(
        svg`<line x1=${coilX} y1=${cy} x2=${coilX} y2=${boxTop} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<line x1=${coilX} y1=${boxTop} x2=${boxLeft} y2=${boxTop} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<rect x=${boxLeft} y=${boxTop} width=${boxW} height=${boxBottom - boxTop} rx="3" class=${cls} fill="none" />`,
      );
      painter.parts.push(
        svg`<text x=${boxCx} y=${boxTop - 4} class="fb-text">${layout.title}</text>`,
      );
      layout.ins.forEach((pin, idx) => {
        const py = pinY(idx);
        painter.parts.push(
          svg`<text x=${boxLeft + 5} y=${py + 4} class="pin-l">${pin.label}</text>`,
        );
        painter.parts.push(
          svg`<line x1=${boxLeft - 12} y1=${py} x2=${boxLeft} y2=${py} class="wire" />`,
        );
        painter.parts.push(
          svg`<text x=${boxLeft - 14} y=${py + 4} class="pin-v-l">${pin.value}</text>`,
        );
      });
      // The destination pin sits on the coil row (right edge).
      painter.parts.push(
        svg`<text x=${boxRight - 5} y=${cy + 4} class="pin-r">${layout.outs[0].label}</text>`,
      );
      painter.parts.push(
        svg`<line x1=${boxRight} y1=${cy} x2=${boxRight + 12} y2=${cy} class="wire" />`,
      );
      painter.parts.push(
        svg`<text x=${boxRight + 14} y=${cy + 4} class="pin-v-r">${layout.outs[0].value}</text>`,
      );
      return;
    }

    const value = cf?.value ?? false;
    const cls = energised ? "coil live" : "coil";
    // Wire into the coil, then the coil drawn as a parenthesis pair "( )" as in
    // common PLC packages. S/R modes show the letter between the parentheses.
    painter.parts.push(
      svg`<line x1=${coilX} y1=${cy} x2=${cx - 9} y2=${cy} class=${wireClass(energised)} />`,
    );
    painter.parts.push(
      svg`<path d="M ${cx - 6} ${cy - 13} Q ${cx - 15} ${cy} ${cx - 6} ${cy + 13}" class=${cls} fill="none" />`,
    );
    painter.parts.push(
      svg`<path d="M ${cx + 6} ${cy - 13} Q ${cx + 15} ${cy} ${cx + 6} ${cy + 13}" class=${cls} fill="none" />`,
    );
    painter.parts.push(svg`<text x=${cx} y=${cy - 20} class="tag">${output.tag}</text>`);
    const mode = output.mode ?? "=";
    if (mode !== "=") {
      painter.parts.push(
        svg`<text x=${cx} y=${cy + 5} class=${value ? "coil-mode live" : "coil-mode"}>${mode}</text>`,
      );
    }
  });

  const height = rows * CELL_H;

  // Editor overlay: transparent hit-targets over the ladder, drawn last so they
  // sit on top. Only emitted when the panel passes an `edit` config.
  if (edit) {
    const selEl = (ei: number) =>
      edit.selected?.kind === "el" &&
      edit.selected.ni === edit.ni &&
      edit.selected.ri === ri &&
      edit.selected.steps.length === 0 &&
      edit.selected.ei === ei;

    // Whether a slot is the current palette drop target (highlighted while dragging).
    const isDrop = (steps: SeriesStep[], index: number) =>
      edit.placeDrop != null &&
      edit.placeDrop.ri === ri &&
      sameSteps(edit.placeDrop.steps, steps) &&
      edit.placeDrop.index === index;

    let col = 0;
    const slotXs: number[] = [];
    const targets: SlotTarget[] = [];
    // Record a top-level slot as a drop target (always) and draw it (armed only).
    const slot = (c: number, index: number) => {
      slotXs.push(colX(c));
      targets.push({ steps: [], index, x: colX(c), top: baseY, bottom: baseY + height });
      if (edit.armed !== "element") return;
      painter.parts.push(
        svg`<rect class="hit-slot ${isDrop([], index) ? "targeted" : ""}"
          x=${colX(c) - 7} y=${baseY} width="14" height=${height}
          @click=${() => edit.onInsertElement(ri, [], index)} />`,
      );
    };
    rung.series.forEach((el, ei) => {
      slot(col, ei);
      const w = measureElement(el).cols;
      if (edit.armed === null) {
        const dragging =
          edit.drag != null && edit.drag.ri === ri && edit.drag.ei === ei;
        painter.parts.push(
          svg`<rect class="hit-el drag-el ${selEl(ei) ? "sel" : ""} ${dragging ? "dragging" : ""}"
            x=${colX(col)} y=${baseY}
            width=${colX(col + w) - colX(col)} height=${height}
            @pointerdown=${(ev: PointerEvent) => edit.onElementPointerDown?.(ri, ei, ev)} />`,
        );
      } else if (selEl(ei)) {
        painter.parts.push(
          svg`<rect class="sel-outline" x=${colX(col)} y=${baseY}
            width=${colX(col + w) - colX(col)} height=${height} />`,
        );
      }
      col += w;
    });
    slot(col, rung.series.length);

    // Drop indicator for an in-progress *reorder* (a palette drop instead
    // highlights its target slot via the `targeted` class).
    if (edit.drag != null && edit.drag.ri === ri) {
      const dx = slotXs[edit.drag.drop];
      if (dx !== undefined) {
        painter.parts.push(
          svg`<line class="drop-indicator" x1=${dx} y1=${baseY} x2=${dx} y2=${baseY + height} />`,
        );
      }
    }

    rung.coils.forEach((coil, i) => {
      const cy = baselineY + i * CELL_H;
      // A move/calc draws a wider box than a simple coil; widen its hit-target so
      // the whole block (and its value labels) is clickable/outlined.
      const hitW = isMove(coil) || isCalc(coil) ? OUTPUT_BLOCK_SPACE : CELL_W;
      const sel =
        edit.selected?.kind === "coil" &&
        edit.selected.ni === edit.ni &&
        edit.selected.ri === ri &&
        edit.selected.ci === i;
      if (edit.armed === null) {
        painter.parts.push(
          svg`<rect class="hit-el ${sel ? "sel" : ""}" x=${coilX} y=${cy - CELL_H / 2}
            width=${hitW} height=${CELL_H} @click=${() => edit.onSelectCoil(ri, i)} />`,
        );
      } else if (sel) {
        painter.parts.push(
          svg`<rect class="sel-outline" x=${coilX} y=${cy - CELL_H / 2}
            width=${hitW} height=${CELL_H} />`,
        );
      }
    });
    if (edit.armed === "coil") {
      const cy = baselineY + rung.coils.length * CELL_H;
      painter.parts.push(
        svg`<rect class="hit-slot" x=${coilX} y=${cy - CELL_H / 2} width=${CELL_W} height="14"
          @click=${() => edit.onInsertCoil(ri, rung.coils.length)} />`,
      );
    }

    // Nested (branch-path) editing: hit-targets for elements *inside* branches,
    // addressed by their SeriesStep path. Top-level (steps=[]) is handled above,
    // so here we descend into branches only. Parent-before-child walk order puts
    // child targets on top, so clicking a sub-element wins over its branch box.
    const walk = walkSeries(rung.series);
    if (edit.allowNestedInsert) {
      // A branch entry/exit column is shared by the parent series' slot beside
      // the branch AND that branch's first/last path slot, so they'd overlap.
      // Spread them: each slot steps right by its "rank" = how many *shallower*
      // slots share the same column and vertical band. The parent (before the
      // branch) keeps the column; each deeper (inside-branch) slot moves right,
      // so both stay clickable. Non-overlapping slots have rank 0 (unmoved).
      const band = (info: SeriesInfo) => {
        const top = info.steps.length === 0 ? baseY : baseY + info.row * CELL_H;
        const bottom = info.steps.length === 0 ? baseY + height : top + CELL_H;
        return { top, bottom };
      };
      const all = walk.series.flatMap((info) => {
        const { top, bottom } = band(info);
        return info.slotCols.map((c) => ({ col: c, top, bottom, depth: info.steps.length }));
      });
      const rank = (col: number, top: number, bottom: number, depth: number) =>
        all.filter(
          (s) => s.col === col && s.depth < depth && s.bottom > top && s.top < bottom,
        ).length;
      const nested = walk.series
        .filter((s) => s.steps.length > 0)
        .sort((a, b) => a.steps.length - b.steps.length);
      for (const info of nested) {
        const top = baseY + info.row * CELL_H;
        const last = info.slotCols.length - 1;
        info.slotCols.forEach((c, index) => {
          // Step toward the inside of the branch: the entry slot (first) steps
          // right, the exit/join slot (last) steps left, so both sit inside the
          // branch rather than past the join line.
          const dir = index === last && index !== 0 ? -1 : 1;
          const dx = rank(c, top, top + CELL_H, info.steps.length) * SLOT_SPREAD * dir;
          const cx = colX(c) + dx;
          targets.push({ steps: info.steps, index, x: cx, top, bottom: top + CELL_H });
          painter.parts.push(
            svg`<rect class="hit-slot ${isDrop(info.steps, index) ? "targeted" : ""}"
              x=${cx - 7} y=${top} width="14" height=${CELL_H}
              @click=${() => edit.onInsertElement(ri, info.steps, index)} />`,
          );
        });
      }
    } else if (edit.armed === null) {
      for (const cell of walk.cells) {
        if (cell.steps.length === 0) continue;
        const sel =
          edit.selected?.kind === "el" &&
          edit.selected.ni === edit.ni &&
          edit.selected.ri === ri &&
          sameSteps(edit.selected.steps, cell.steps) &&
          edit.selected.ei === cell.ei;
        const x = colX(cell.col);
        painter.parts.push(
          svg`<rect class="hit-el ${sel ? "sel" : ""}" x=${x} y=${baseY + cell.row * CELL_H}
            width=${colX(cell.col + cell.cols) - x} height=${cell.rows * CELL_H}
            @click=${() => edit.onSelectElement(ri, cell.steps, cell.ei)} />`,
        );
      }
    }

    // A "+ path" control at the bottom-left of every branch, so a new OR-path can
    // be added on the canvas (arm an element tool first to seed the path with it).
    if (edit.onAddPath) {
      for (const cell of walk.cells) {
        if (!isBranch(cell.el)) continue;
        const bx = colX(cell.col);
        const by = baseY + (cell.row + cell.rows) * CELL_H - 13;
        painter.parts.push(
          svg`<g class="add-path" @click=${() => edit.onAddPath?.(ri, cell.steps, cell.ei)}>
            <circle cx=${bx} cy=${by} r="9" />
            <text x=${bx} y=${by + 4}>+</text>
          </g>`,
        );
      }
    }

    // Report geometry after both passes so `targets` includes nested slots.
    edit.onGeometry?.(ri, { top: baseY, bottom: baseY + height, slotXs, targets });
  }

  return { part: svg`<g>${painter.parts}</g>`, height };
}

export interface RenderedNetwork {
  part: SVGTemplateResult;
  height: number;
}

export function renderNetwork(
  network: Network,
  flow: PowerFlow,
  width: number,
  fbs: Record<string, FunctionBlockDef>,
  state: StateImage,
  edit?: CanvasEdit,
): RenderedNetwork {
  const parts: SVGTemplateResult[] = [];
  let y = TITLE_H;
  if (network.title) {
    parts.push(svg`<text x=${PAD} y="15" class="network-title">${network.title}</text>`);
  }
  network.rungs.forEach((rung, ri) => {
    const r = renderRung(rung, y, flow, width, fbs, state, edit, ri);
    parts.push(r.part);
    y += r.height + RUNG_GAP;
  });
  return { part: svg`<g>${parts}</g>`, height: y + PAD };
}
