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
  Output,
  Rung,
  StateImage,
  isAction,
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
/** Vertical room a rung's title takes above the rung itself. */
const RUNG_TITLE_H = 18;
const RAIL_W = 10;
const SYMBOL_HALF = 9;
/** Vertical gap between stacked rungs in a network. */
export const RUNG_GAP = 12;
/** Horizontal step between insert slots that would otherwise overlap (px). */
const SLOT_SPREAD = 15;
/** Vertical gap between a function block's stacked pins (px). */
const PIN_GAP = 20;
/** Vertical gap between a coil-column output block's stacked pins (px). */
const OUT_PIN_GAP = 16;
/** Right-hand space reserved for a rung with a REAL output block (move/calc). */
const OUTPUT_BLOCK_SPACE = 214;

/** Number of coil-column rows an output occupies (a taller calc claims two). */
function outputRows(output: Output): number {
  return isCalc(output) ? 2 : 1;
}

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
    // Read like a contact: what is being compared (with its live value) above,
    // the operator alone inside the box, and what it is compared against below.
    const leftVal = fmtNumber(this.state[el.left]);
    const leftLabel = leftVal !== null ? `${el.left} = ${leftVal}` : el.left;
    this.label(mid, y - 20, leftLabel, "tag");
    this.label(mid, y + 5, OP_SYMBOL[el.op], "compare-text");
    let rightLabel = String(el.right);
    if (typeof el.right === "string") {
      const rv = fmtNumber(this.state[el.right]);
      if (rv !== null) rightLabel = `${el.right} = ${rv}`;
    }
    this.label(mid, y + 26, rightLabel, "tag");
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
  /** The element being drag-reordered in this network (dimmed as a ghost), or null. */
  dragSource?: { ri: number; steps: SeriesStep[]; ei: number } | null;
  /** Which insertion slot a dragged element (palette or reorder) would drop into. */
  placeDrop?: { ri: number; steps: SeriesStep[]; index: number } | null;
  /**
   * Show insertion slots *inside* branches (for a persistently armed element tool,
   * a palette element drag, or a reorder drag). The nested slot *geometry* is always
   * reported via `onGeometry` regardless, so a drag can hit-test into a branch.
   */
  allowNestedInsert?: boolean;
  /** Series-element positions flagged by validation, tinted red. */
  errorEls?: { ri: number; steps: SeriesStep[]; ei: number }[];
  /** Coil/output positions flagged by validation, tinted red. */
  errorCoils?: { ri: number; ci: number }[];
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
   * A pointer went down on an element hit-target (`steps` = [] for a top-level
   * element, or the branch path for a nested one). The panel decides whether it
   * becomes a drag (moved) or a select (released in place).
   */
  onElementPointerDown?: (
    ri: number,
    steps: SeriesStep[],
    ei: number,
    ev: PointerEvent,
  ) => void;
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
  const painter = new RungPainter(baseY, flow, fbs, state);
  const baselineY = rowY(baseY, 0);

  // Each output claims one or more coil rows: a simple coil sits centred on one
  // row; a move/calc draws a taller TIA-style box (power line on top, operand rows
  // below) so it claims extra rows. `coilTaps[i]` is the y of output i's power
  // line; outputs stack by their own heights rather than a fixed row each.
  const coilTaps: number[] = [];
  let coilRowAcc = 0;
  for (const output of rung.coils) {
    coilTaps.push(baselineY + coilRowAcc * CELL_H);
    coilRowAcc += outputRows(output);
  }
  const totalCoilRows = coilRowAcc;
  // The rung is as tall as its widest need: the series' branch rows or the stacked
  // coil rows.
  const rows = Math.max(measure.rows, totalCoilRows, 1);

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
  const hasOutputBlock = rung.coils.some(
    (o) => isMove(o) || isCalc(o) || isAction(o),
  );
  const rightSpace = hasOutputBlock ? OUTPUT_BLOCK_SPACE : 120;
  const coilX = Math.max(colX(res.endCol) + 24, width - rightSpace);
  painter.parts.push(
    svg`<line x1=${colX(res.endCol)} y1=${baselineY} x2=${coilX} y2=${baselineY} class=${wireClass(res.poweredOut)} />`,
  );
  // Vertical bus down the coil column so stacked coils share the rung's power.
  if (rung.coils.length > 1) {
    const busBottom = coilTaps[coilTaps.length - 1];
    painter.parts.push(
      svg`<line x1=${coilX} y1=${baselineY} x2=${coilX} y2=${busBottom} class=${wireClass(res.poweredOut)} />`,
    );
  }
  rung.coils.forEach((output, i) => {
    const cf = flow.coils.get(output);
    const energised = cf?.energised ?? false;
    const cy = coilTaps[i];
    // Sit the output about half a cell right of the bus, so the stub matches the
    // spacing used between a branch bus and its parallel contacts.
    const cx = coilX + CELL_W / 2;

    if (isAction(output)) {
      // A service-call output: a box labelled with the service it fires, coloured
      // by whether its rung is energised (it fires on the rising edge). The target
      // entity, if any, is shown below.
      const cls = energised ? "symbol live" : "symbol";
      const boxW = 150;
      const boxLeft = coilX + 16;
      const boxCx = boxLeft + boxW / 2;
      painter.parts.push(
        svg`<line x1=${coilX} y1=${cy} x2=${boxLeft} y2=${cy} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<rect x=${boxLeft} y=${cy - 14} width=${boxW} height="28" rx="3" class=${cls} fill="none" />`,
      );
      painter.parts.push(svg`<text x=${boxCx} y=${cy - 18} class="mode">do</text>`);
      painter.parts.push(
        svg`<text x=${boxCx} y=${cy + 4} class="fb-text">${output.service || "?"}</text>`,
      );
      const target = output.data?.entity_id;
      if (typeof target === "string" && target) {
        painter.parts.push(svg`<text x=${boxCx} y=${cy + 25} class="tag">${target}</text>`);
      }
      // Any chosen option value (preset_mode, option, source, …), shown below.
      const choice = Object.entries(output.data ?? {}).find(
        ([k, v]) => k !== "entity_id" && typeof v === "string" && v,
      );
      if (choice) {
        painter.parts.push(
          svg`<text x=${boxCx} y=${cy + 38} class="tag">${String(choice[1])}</text>`,
        );
      }
      return;
    }

    if (isMove(output) || isCalc(output)) {
      // TIA-style output box aligned like a function block: the enable (rung
      // result) runs straight in along the coil row (the box's top row), the box
      // hangs below it, operand inputs stack down the left, the destination sits
      // on the right at the first operand row. Coloured by whether it energised.
      const layout = outputBlock(output, state);
      const cls = energised ? "symbol live" : "symbol";
      const boxW = 56;
      const boxLeft = coilX + 76;
      const boxRight = boxLeft + boxW;
      const boxCx = (boxLeft + boxRight) / 2;
      // Operand k sits one gap below the power line; the box spans from just above
      // the power line to just below the last operand.
      const opY = (k: number) => cy + (k + 1) * OUT_PIN_GAP;
      const boxTop = cy - 15;
      const boxBottom = opY(layout.ins.length - 1) + 11;

      // Enable wire straight in along the power row, into the box's left edge.
      painter.parts.push(
        svg`<line x1=${coilX} y1=${cy} x2=${boxLeft} y2=${cy} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<rect x=${boxLeft} y=${boxTop} width=${boxW} height=${boxBottom - boxTop} rx="3" class=${cls} fill="none" />`,
      );
      painter.parts.push(
        svg`<text x=${boxCx} y=${cy + 4} class="fb-text">${layout.title}</text>`,
      );
      layout.ins.forEach((pin, k) => {
        const py = opY(k);
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
      // The destination pin sits on the right at the first operand row.
      const dstY = opY(0);
      painter.parts.push(
        svg`<text x=${boxRight - 5} y=${dstY + 4} class="pin-r">${layout.outs[0].label}</text>`,
      );
      painter.parts.push(
        svg`<line x1=${boxRight} y1=${dstY} x2=${boxRight + 12} y2=${dstY} class="wire" />`,
      );
      painter.parts.push(
        svg`<text x=${boxRight + 14} y=${dstY + 4} class="pin-v-r">${layout.outs[0].value}</text>`,
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
        painter.parts.push(
          svg`<rect class="hit-el drag-el ${selEl(ei) ? "sel" : ""}"
            x=${colX(col)} y=${baseY}
            width=${colX(col + w) - colX(col)} height=${height}
            @pointerdown=${(ev: PointerEvent) => edit.onElementPointerDown?.(ri, [], ei, ev)} />`,
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

    rung.coils.forEach((coil, i) => {
      const cy = coilTaps[i];
      // A move/calc draws a wider, taller box than a simple coil; widen and
      // heighten its hit-target so the whole block (and its labels) is clickable.
      const isBlock = isMove(coil) || isCalc(coil) || isAction(coil);
      const hitW = isBlock ? OUTPUT_BLOCK_SPACE : CELL_W;
      const hitH = outputRows(coil) * CELL_H;
      const sel =
        edit.selected?.kind === "coil" &&
        edit.selected.ni === edit.ni &&
        edit.selected.ri === ri &&
        edit.selected.ci === i;
      if (edit.armed === null) {
        painter.parts.push(
          svg`<rect class="hit-el ${sel ? "sel" : ""}" x=${coilX} y=${cy - CELL_H / 2}
            width=${hitW} height=${hitH} @click=${() => edit.onSelectCoil(ri, i)} />`,
        );
      } else if (sel) {
        painter.parts.push(
          svg`<rect class="sel-outline" x=${coilX} y=${cy - CELL_H / 2}
            width=${hitW} height=${hitH} />`,
        );
      }
    });
    if (edit.armed === "coil") {
      const cy = baselineY + totalCoilRows * CELL_H;
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

    // Validation error tints: a translucent red rect behind each flagged element
    // or output (drawn among the overlay, pointer-transparent so it never blocks
    // a click; the symbol underneath still shows through).
    if (edit.errorEls?.length) {
      for (const cell of walk.cells) {
        const flagged = edit.errorEls.some(
          (e) => e.ri === ri && e.ei === cell.ei && sameSteps(e.steps, cell.steps),
        );
        if (!flagged) continue;
        const x = colX(cell.col);
        painter.parts.push(
          svg`<rect class="err-cell" x=${x} y=${baseY + cell.row * CELL_H}
            width=${colX(cell.col + cell.cols) - x} height=${cell.rows * CELL_H} />`,
        );
      }
    }
    if (edit.errorCoils?.length) {
      rung.coils.forEach((coil, ci) => {
        if (!edit.errorCoils!.some((e) => e.ri === ri && e.ci === ci)) return;
        const cy = coilTaps[ci];
        const w = isMove(coil) || isCalc(coil) ? OUTPUT_BLOCK_SPACE : CELL_W;
        painter.parts.push(
          svg`<rect class="err-cell" x=${coilX} y=${cy - CELL_H / 2}
            width=${w} height=${outputRows(coil) * CELL_H} />`,
        );
      });
    }

    // Nested insertion slots. A branch entry/exit column is shared by the parent
    // series' slot beside the branch AND that branch's first/last path slot, so
    // they'd overlap. Spread them: each slot steps right by its "rank" = how many
    // *shallower* slots share the same column and vertical band. The parent (before
    // the branch) keeps the column; each deeper (inside-branch) slot moves right,
    // so both stay clickable. Non-overlapping slots have rank 0 (unmoved). The
    // *geometry* is computed always (so a drag can hit-test into a branch); the slot
    // rects are only drawn while inserting/dragging (`allowNestedInsert`).
    {
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
          const nx = colX(c) + dx;
          targets.push({ steps: info.steps, index, x: nx, top, bottom: top + CELL_H });
          if (edit.allowNestedInsert) {
            painter.parts.push(
              svg`<rect class="hit-slot ${isDrop(info.steps, index) ? "targeted" : ""}"
                x=${nx - 7} y=${top} width="14" height=${CELL_H}
                @click=${() => edit.onInsertElement(ri, info.steps, index)} />`,
            );
          }
        });
      }
    }

    // Nested element hit-targets: selectable + draggable when idle (armed null).
    if (edit.armed === null) {
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
          svg`<rect class="hit-el drag-el ${sel ? "sel" : ""}"
            x=${x} y=${baseY + cell.row * CELL_H}
            width=${colX(cell.col + cell.cols) - x} height=${cell.rows * CELL_H}
            @pointerdown=${(ev: PointerEvent) =>
              edit.onElementPointerDown?.(ri, cell.steps, cell.ei, ev)} />`,
        );
      }
    }

    // Ghost the element being drag-reordered (source), at any depth.
    if (edit.dragSource && edit.dragSource.ri === ri) {
      const ds = edit.dragSource;
      const cell = walk.cells.find(
        (c) => c.ei === ds.ei && sameSteps(c.steps, ds.steps),
      );
      if (cell) {
        const x = colX(cell.col);
        painter.parts.push(
          svg`<rect class="drag-ghost" x=${x} y=${baseY + cell.row * CELL_H}
            width=${colX(cell.col + cell.cols) - x} height=${cell.rows * CELL_H} />`,
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
  /**
   * The user-space width the network actually needs. This is the requested
   * `width` for normal networks (so the output column keeps its usual place),
   * but grows for a rung whose series is too long to fit — otherwise that rung's
   * output column would be drawn outside the viewBox and get clipped.
   */
  width: number;
}

/** The width a rung needs: its series, the stub, and room for its output. */
function rungRequiredWidth(rung: Rung): number {
  const hasOutputBlock = rung.coils.some(
    (o) => isMove(o) || isCalc(o) || isAction(o),
  );
  const rightSpace = hasOutputBlock ? OUTPUT_BLOCK_SPACE : 120;
  return colX(measureSeries(rung.series).cols) + 24 + rightSpace;
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
  // Grow to the widest rung so nothing is clipped; never shrink below `width`,
  // so small networks keep their output column on the usual line.
  const contentWidth = network.rungs.reduce(
    (w, rung) => Math.max(w, rungRequiredWidth(rung)),
    width,
  );
  let y = TITLE_H;
  // The editor shows the network title in its own header (next to the id chip),
  // so drawing it here as well would duplicate it. The read-only card has no
  // header, so there it is drawn. The top padding is reserved either way, so the
  // rung geometry is identical in both.
  if (network.title && !edit) {
    parts.push(svg`<text x=${PAD} y="15" class="network-title">${network.title}</text>`);
  }
  network.rungs.forEach((rung, ri) => {
    // A rung's own title sits above it, and pushes the rung down by its height —
    // drawn here rather than in `renderRung` so every geometry the editor reports
    // (hit-targets, slot positions, y-bands) keeps using the baseY it is given.
    if (rung.title) {
      parts.push(svg`<text x=${PAD} y=${y + 12} class="rung-title">${rung.title}</text>`);
      y += RUNG_TITLE_H;
    }
    const r = renderRung(rung, y, flow, contentWidth, fbs, state, edit, ri);
    parts.push(r.part);
    y += r.height + RUNG_GAP;
  });
  return { part: svg`<g>${parts}</g>`, height: y + PAD, width: contentWidth };
}
