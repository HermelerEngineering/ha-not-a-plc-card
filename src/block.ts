/**
 * Pure "pin" layout for function-block instances — the TIA-style block face.
 *
 * A function block is drawn as a labelled box with input pins down its left edge
 * and output pins down its right edge. Each pin has a short role label shown
 * *inside* the box (IN, PT, PV, R, Q, ET, CV, …); a parameter/setting or a live
 * value is shown *outside* the box next to its pin (settings to the left of an
 * input, live values to the right of an output). Power pins (the rung line in and
 * the block's Q out) carry no side value — they connect to the ladder wire.
 *
 * This module is presentation-neutral and lit-free so it can be unit-tested; the
 * SVG geometry lives in `render.ts`.
 */

import { CalcEl, FunctionBlockDef, MoveEl, StateImage } from "./ir";

const CALC_NAME: Record<string, string> = {
  ADD: "ADD",
  SUB: "SUB",
  MUL: "MUL",
  DIV: "DIV",
};

export interface BlockPin {
  /** Short role label drawn inside the box (e.g. "IN", "PT", "Q", "ET"). */
  label: string;
  /** Setting / bound tag / live value drawn outside the box; undefined = power. */
  value?: string;
  /** True for the rung-power pin (wired to the ladder line, no side value). */
  power?: boolean;
}

export interface BlockLayout {
  /** Block type shown at the top of the box (e.g. "TON", "CTU", "R_TRIG"). */
  title: string;
  ins: BlockPin[];
  outs: BlockPin[];
}

const TIMER = ["TON", "TOF", "TP"];

function fmtNum(value: boolean | number | undefined): string | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A bound tag reference for a secondary input, or "—" when unset. */
function tagRef(value: unknown): string {
  return typeof value === "string" && value ? value : "—";
}

/** A numeric setting (e.g. PV), or "—" when unset. */
function numSetting(value: unknown): string {
  return typeof value === "number" ? String(value) : "—";
}

/**
 * The pin face for a function-block instance: which inputs/outputs it has, their
 * role labels, and the setting or live value to show beside each. `state` supplies
 * live `instance.ET` / `instance.CV` values (falling back to "0" before the first
 * push). The first input and first output are always the rung-power pins so they
 * line up with the ladder baseline.
 */
export function fbBlock(
  instance: string,
  def: FunctionBlockDef | undefined,
  state: StateImage,
): BlockLayout {
  const type = def?.type ?? "FB";
  const et = fmtNum(state[`${instance}.ET`]) ?? "0";
  const cv = fmtNum(state[`${instance}.CV`]) ?? "0";

  if (TIMER.includes(type)) {
    const preset = def?.preset_ms;
    return {
      title: type,
      ins: [
        { label: "IN", power: true },
        { label: "PT", value: typeof preset === "number" ? `${preset}ms` : "—" },
      ],
      outs: [
        { label: "Q", power: true },
        { label: "ET", value: et },
      ],
    };
  }

  if (type === "CTU") {
    return {
      title: type,
      ins: [
        { label: "CU", power: true },
        { label: "R", value: tagRef(def?.reset) },
        { label: "PV", value: numSetting(def?.pv) },
      ],
      outs: [
        { label: "Q", power: true },
        { label: "CV", value: cv },
      ],
    };
  }

  if (type === "CTD") {
    return {
      title: type,
      ins: [
        { label: "CD", power: true },
        { label: "LD", value: tagRef(def?.load) },
        { label: "PV", value: numSetting(def?.pv) },
      ],
      outs: [
        { label: "Q", power: true },
        { label: "CV", value: cv },
      ],
    };
  }

  if (type === "SR" || type === "RS") {
    // Both set via the rung power (row 0); the reset is a bound tag input.
    return {
      title: type,
      ins: [
        { label: "S", power: true },
        { label: "R", value: tagRef(def?.reset) },
      ],
      outs: [{ label: "Q", power: true }],
    };
  }

  // Edges (R_TRIG / F_TRIG) and any unknown type: a single power in/out.
  return {
    title: type,
    ins: [{ label: "CLK", power: true }],
    outs: [{ label: "Q", power: true }],
  };
}

/** Number of pin rows a block face needs (power pin row + parameter rows). */
export function blockPinRows(layout: BlockLayout): number {
  return Math.max(layout.ins.length, layout.outs.length);
}

/** An operand (number / REAL tag / fb output) as a label with its live value. */
function operandLabel(operand: number | string, state: StateImage): string {
  if (typeof operand !== "string") return String(operand);
  const v = fmtNum(state[operand]);
  return v !== undefined ? `${operand}=${v}` : operand;
}

/**
 * The pin face for a REAL output (move/calc) — the same idea as `fbBlock` but for
 * the coil-column boxes: operand inputs on the left, the destination on the right.
 * `move` has one input (IN = src); `calc` has two (IN1 = a, IN2 = b) with the
 * operator as the title. All pins carry a value (there is no rung-power pin — the
 * enable is the incoming rung wire, drawn separately).
 */
export function outputBlock(
  output: MoveEl | CalcEl,
  state: StateImage,
): BlockLayout {
  const dst: BlockPin = { label: "OUT", value: operandLabel(output.dst, state) };
  if (output.type === "move") {
    return {
      title: "MOVE",
      ins: [{ label: "IN", value: operandLabel(output.src, state) }],
      outs: [dst],
    };
  }
  return {
    title: CALC_NAME[output.op] ?? "CALC",
    ins: [
      { label: "IN1", value: operandLabel(output.a, state) },
      { label: "IN2", value: operandLabel(output.b, state) },
    ],
    outs: [dst],
  };
}
