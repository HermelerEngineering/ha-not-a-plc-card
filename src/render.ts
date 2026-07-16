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
  isCalc,
  isCompare,
  isContact,
  isFb,
  isMove,
  isNot,
} from "./ir";
import { PowerFlow } from "./power-flow";

const CALC_SYMBOL: Record<string, string> = {
  ADD: "+",
  SUB: "−",
  MUL: "×",
  DIV: "÷",
};

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

interface Measure {
  cols: number;
  rows: number;
}

function measureElement(el: Element): Measure {
  if (isContact(el)) return { cols: 1, rows: 1 };
  if (isCompare(el)) return { cols: 1, rows: 1 };
  if (isFb(el)) return { cols: 1, rows: 1 };
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

function measureSeries(els: Element[]): Measure {
  let cols = 0;
  let rows = 1;
  for (const el of els) {
    const m = measureElement(el);
    cols += m.cols;
    rows = Math.max(rows, m.rows);
  }
  return { cols: Math.max(cols, 1), rows };
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
    const y = rowY(this.baseY, row);
    const left = colX(col);
    const right = colX(col + 1);
    const mid = (left + right) / 2;
    const boxW = 66;
    const boxH = 30;

    this.line(left, y, mid - boxW / 2, y, powered);
    this.line(mid + boxW / 2, y, right, y, live);

    const cls = live ? "symbol live" : "symbol";
    this.parts.push(
      svg`<rect x=${mid - boxW / 2} y=${y - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
    );
    // Instance name above, block type inside; counters also show CV/PV below.
    const def = this.fbs[el.instance];
    this.label(mid, y - 22, el.instance, "tag");
    this.label(mid, y + 4, def?.type ?? "FB", "fb-text");
    const cv = fmtNumber(this.state[`${el.instance}.CV`]);
    if (cv !== null) {
      const pv = def && typeof def.pv === "number" ? def.pv : undefined;
      // Below the box (its bottom is at y + boxH/2 = y + 15), not over the edge.
      this.label(mid, y + 27, pv !== undefined ? `${cv}/${pv}` : cv, "compare-text");
    }
    return { endCol: col + 1, poweredOut: live };
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
    | { kind: "el"; ni: number; ri: number; ei: number }
    | { kind: "coil"; ni: number; ri: number; ci: number };
  /** The in-progress top-level element drag in this network, or null. */
  drag?: { ri: number; ei: number; drop: number } | null;
  onInsertElement: (ri: number, index: number) => void;
  onInsertCoil: (ri: number, index: number) => void;
  onSelectCoil: (ri: number, ci: number) => void;
  /** Reports the x of each top-level insertion slot for a rung (drag geometry). */
  onGeometry?: (ri: number, slotXs: number[]) => void;
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

  // Wire from the last element to the coils on the right, then the coils.
  const coilX = Math.max(colX(res.endCol) + 24, width - 120);
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

    if (isMove(output)) {
      // A move is drawn as a box "dst := src" coloured by the rung result.
      const cls = energised ? "symbol live" : "symbol";
      const boxW = 74;
      const boxH = 26;
      painter.parts.push(
        svg`<line x1=${coilX} y1=${cy} x2=${cx - boxW / 2} y2=${cy} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<rect x=${cx - boxW / 2} y=${cy - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
      );
      const dstVal = fmtNumber(state[output.dst]);
      const dstLabel = dstVal !== null ? `${output.dst} = ${dstVal}` : output.dst;
      painter.parts.push(svg`<text x=${cx} y=${cy - 20} class="tag">${dstLabel}</text>`);
      let srcLabel = String(output.src);
      if (typeof output.src === "string") {
        const sv = fmtNumber(state[output.src]);
        if (sv !== null) srcLabel = `${output.src}=${sv}`;
      }
      painter.parts.push(
        svg`<text x=${cx} y=${cy + 4} class="compare-text">:= ${srcLabel}</text>`,
      );
      return;
    }

    if (isCalc(output)) {
      // dst := a <op> b box, coloured by the rung result.
      const cls = energised ? "symbol live" : "symbol";
      const boxW = 92;
      const boxH = 26;
      painter.parts.push(
        svg`<line x1=${coilX} y1=${cy} x2=${cx - boxW / 2} y2=${cy} class=${wireClass(energised)} />`,
      );
      painter.parts.push(
        svg`<rect x=${cx - boxW / 2} y=${cy - boxH / 2} width=${boxW} height=${boxH} rx="3" class=${cls} fill="none" />`,
      );
      const dstVal = fmtNumber(state[output.dst]);
      const dstLabel = dstVal !== null ? `${output.dst} = ${dstVal}` : output.dst;
      painter.parts.push(svg`<text x=${cx} y=${cy - 20} class="tag">${dstLabel}</text>`);
      const operand = (o: number | string): string => {
        if (typeof o !== "string") return String(o);
        const v = fmtNumber(state[o]);
        return v !== null ? `${o}=${v}` : o;
      };
      const expr = `${operand(output.a)} ${CALC_SYMBOL[output.op] ?? "?"} ${operand(output.b)}`;
      painter.parts.push(
        svg`<text x=${cx} y=${cy + 4} class="compare-text">:= ${expr}</text>`,
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
      edit.selected.ei === ei;

    let col = 0;
    const slotXs: number[] = [];
    const slot = (c: number, index: number) => {
      if (edit.armed !== "element") return;
      painter.parts.push(
        svg`<rect class="hit-slot" x=${colX(c) - 7} y=${baseY} width="14" height=${height}
          @click=${() => edit.onInsertElement(ri, index)} />`,
      );
    };
    rung.series.forEach((el, ei) => {
      slotXs.push(colX(col));
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
    slotXs.push(colX(col));
    slot(col, rung.series.length);
    edit.onGeometry?.(ri, slotXs);

    // Drop indicator: a vertical marker at the target insertion slot while a
    // top-level element in this rung is being dragged.
    if (edit.drag != null && edit.drag.ri === ri) {
      const dx = slotXs[edit.drag.drop];
      if (dx !== undefined) {
        painter.parts.push(
          svg`<line class="drop-indicator" x1=${dx} y1=${baseY} x2=${dx} y2=${baseY + height} />`,
        );
      }
    }

    rung.coils.forEach((_coil, i) => {
      const cy = baselineY + i * CELL_H;
      const sel =
        edit.selected?.kind === "coil" &&
        edit.selected.ni === edit.ni &&
        edit.selected.ri === ri &&
        edit.selected.ci === i;
      if (edit.armed === null) {
        painter.parts.push(
          svg`<rect class="hit-el ${sel ? "sel" : ""}" x=${coilX} y=${cy - CELL_H / 2}
            width=${CELL_W} height=${CELL_H} @click=${() => edit.onSelectCoil(ri, i)} />`,
        );
      } else if (sel) {
        painter.parts.push(
          svg`<rect class="sel-outline" x=${coilX} y=${cy - CELL_H / 2}
            width=${CELL_W} height=${CELL_H} />`,
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
    y += r.height + 12;
  });
  return { part: svg`<g>${parts}</g>`, height: y + PAD };
}
