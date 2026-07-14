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
  isCompare,
  isContact,
  isFb,
  isNot,
} from "./ir";
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

interface Measure {
  cols: number;
  rows: number;
}

function measureElement(el: Element): Measure {
  if (isContact(el)) return { cols: 1, rows: 1 };
  if (isCompare(el)) return { cols: 1, rows: 1 };
  if (isFb(el)) return { cols: 1, rows: 1 };
  if (isNot(el)) return measureSeries(el.not);
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
    const flow = this.flow.elements.get(el);
    const live = flow?.live ?? false;
    // Draw the inner series informationally; the NOT itself carries the power.
    const res = this.drawSeries(el.not, col, row, powered);
    const y = rowY(this.baseY, row);
    const bar = y - 26;
    this.line(colX(col) + 6, bar, colX(res.endCol) - 6, bar, live);
    this.label(colX(col) + 12, bar - 4, "NOT", "mode");
    return { endCol: res.endCol, poweredOut: live };
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

function renderRung(
  rung: Rung,
  baseY: number,
  flow: PowerFlow,
  width: number,
  fbs: Record<string, FunctionBlockDef>,
  state: StateImage,
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
  rung.coils.forEach((coil, i) => {
    const cf = flow.coils.get(coil);
    const energised = cf?.energised ?? false;
    const value = cf?.value ?? false;
    const cy = baselineY + i * CELL_H;
    const cx = coilX + 18;
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
    painter.parts.push(svg`<text x=${cx} y=${cy - 20} class="tag">${coil.tag}</text>`);
    const mode = coil.mode ?? "=";
    if (mode !== "=") {
      painter.parts.push(
        svg`<text x=${cx} y=${cy + 5} class=${value ? "coil-mode live" : "coil-mode"}>${mode}</text>`,
      );
    }
  });

  const height = rows * CELL_H;
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
): RenderedNetwork {
  const parts: SVGTemplateResult[] = [];
  let y = TITLE_H;
  if (network.title) {
    parts.push(svg`<text x=${PAD} y="15" class="network-title">${network.title}</text>`);
  }
  for (const rung of network.rungs) {
    const r = renderRung(rung, y, flow, width, fbs, state);
    parts.push(r.part);
    y += r.height + 12;
  }
  return { part: svg`<g>${parts}</g>`, height: y + PAD };
}
