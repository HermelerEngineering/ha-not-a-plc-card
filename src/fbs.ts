/**
 * Pure helpers for editing function-block instances (`Program.fbs`) — phase 4.3.
 *
 * Mirrors `tags.ts`: side-effect free, immutable, unit-tested with vitest. A
 * function block is declared once in `fbs` (a name → `{type, ...params}` map) and
 * referenced inline by an `fb` element. These helpers add/remove/rename instances,
 * change their type, and edit their typed parameters, keeping the program valid
 * (renaming rewrites every `fb` reference and every `instance.ET`/`instance.CV`
 * compare operand across the IR).
 */

import {
  BranchEl,
  CompareEl,
  Element,
  FunctionBlockDef,
  NotEl,
  Program,
  isBranch,
  isCompare,
  isFb,
  isNot,
} from "./ir";

export const EDGE_TYPES = ["R_TRIG", "F_TRIG"];
export const TIMER_TYPES = ["TON", "TOF", "TP"];
export const COUNTER_TYPES = ["CTU", "CTD"];
export const LATCH_TYPES = ["SR", "RS"];
export const FB_TYPES = [
  ...EDGE_TYPES,
  ...TIMER_TYPES,
  ...COUNTER_TYPES,
  ...LATCH_TYPES,
];

export type FbFieldKind = "int" | "tag";

export interface FbField {
  key: string;
  kind: FbFieldKind;
  label: string;
  optional?: boolean;
}

/** The editable parameter fields for a function-block type. */
export function fbFields(type: string): FbField[] {
  if (TIMER_TYPES.includes(type)) {
    return [{ key: "preset_ms", kind: "int", label: "preset (ms)" }];
  }
  if (type === "CTU") {
    return [
      { key: "pv", kind: "int", label: "preset (PV)" },
      { key: "reset", kind: "tag", label: "reset", optional: true },
    ];
  }
  if (type === "CTD") {
    return [
      { key: "pv", kind: "int", label: "preset (PV)" },
      { key: "load", kind: "tag", label: "load", optional: true },
    ];
  }
  if (LATCH_TYPES.includes(type)) {
    return [{ key: "reset", kind: "tag", label: "reset" }];
  }
  return []; // edges take no parameters
}

/** A new instance of `type` with sensible default parameters. */
export function newFb(type: string): FunctionBlockDef {
  const def: FunctionBlockDef = { type };
  if (TIMER_TYPES.includes(type)) def.preset_ms = 1000;
  else if (COUNTER_TYPES.includes(type)) def.pv = 1;
  // latches need a `reset` tag (left unset until the user picks one); edges none.
  return def;
}

/** The lowest-numbered fresh `fb<n>` instance name not already used. */
export function freshFbName(program: Program): string {
  const taken = new Set(Object.keys(program.fbs ?? {}));
  let n = 1;
  while (taken.has(`fb${n}`)) n += 1;
  return `fb${n}`;
}

function withFbs(program: Program, fbs: Record<string, FunctionBlockDef>): Program {
  return { ...program, fbs };
}

export function addFb(
  program: Program,
  type = "R_TRIG",
): { program: Program; name: string } {
  const name = freshFbName(program);
  const fbs = { ...(program.fbs ?? {}), [name]: newFb(type) };
  return { program: withFbs(program, fbs), name };
}

export function removeFb(program: Program, name: string): Program {
  const fbs = { ...(program.fbs ?? {}) };
  delete fbs[name];
  return withFbs(program, fbs);
}

export function setFb(
  program: Program,
  name: string,
  def: FunctionBlockDef,
): Program {
  return withFbs(program, { ...(program.fbs ?? {}), [name]: def });
}

/** Change an instance's type, resetting its parameters to that type's defaults. */
export function setFbType(program: Program, name: string, type: string): Program {
  if (!program.fbs?.[name]) return program;
  return setFb(program, name, newFb(type));
}

/** Set one parameter; an empty string / undefined clears an optional field. */
export function setFbParam(
  program: Program,
  name: string,
  key: string,
  value: number | string | undefined,
): Program {
  const fb = program.fbs?.[name];
  if (!fb) return program;
  const next: FunctionBlockDef = { ...fb };
  if (value === "" || value === undefined) delete next[key];
  else next[key] = value;
  return setFb(program, name, next);
}

/** The instance a compare operand references via `instance.OUTPUT`, or null. */
function operandInstance(operand: number | string): string | null {
  if (typeof operand !== "string") return null;
  const dot = operand.indexOf(".");
  return dot > 0 ? operand.slice(0, dot) : null;
}

/** Whether `name` is referenced by any `fb` element or `instance.ET/CV` operand. */
export function isFbReferenced(program: Program, name: string): boolean {
  const inElement = (el: Element): boolean => {
    if (isFb(el)) return el.instance === name;
    if (isCompare(el)) {
      return operandInstance(el.left) === name || operandInstance(el.right) === name;
    }
    if (isBranch(el)) return el.branch.some((p) => p.some(inElement));
    if (isNot(el)) return el.not.some(inElement);
    return false;
  };
  return program.networks.some((net) =>
    net.rungs.some((rung) => rung.series.some(inElement)),
  );
}

/** Rewrite a compare operand's instance prefix when it matches `oldName`. */
function renameOperand(
  operand: number | string,
  oldName: string,
  newName: string,
): number | string {
  if (typeof operand !== "string") return operand;
  const dot = operand.indexOf(".");
  if (dot > 0 && operand.slice(0, dot) === oldName) {
    return `${newName}${operand.slice(dot)}`;
  }
  return operand;
}

function renameInElement(el: Element, oldName: string, newName: string): Element {
  if (isFb(el)) {
    return el.instance === oldName ? { ...el, instance: newName } : el;
  }
  if (isCompare(el)) {
    const next: CompareEl = { ...el };
    next.left = String(renameOperand(next.left, oldName, newName));
    next.right = renameOperand(next.right, oldName, newName);
    return next;
  }
  if (isBranch(el)) {
    const next: BranchEl = {
      branch: el.branch.map((path) =>
        path.map((sub) => renameInElement(sub, oldName, newName)),
      ),
    };
    return next;
  }
  if (isNot(el)) {
    const next: NotEl = {
      not: el.not.map((sub) => renameInElement(sub, oldName, newName)),
    };
    return next;
  }
  return el;
}

/**
 * Rename an instance, rewriting every `fb` reference and `instance.ET`/`.CV`
 * compare operand. A no-op when the name is unchanged, empty, or already taken.
 */
export function renameFb(program: Program, oldName: string, newName: string): Program {
  if (newName === oldName) return program;
  if (!newName || newName in (program.fbs ?? {}) || newName in program.tags) {
    return program;
  }

  const fbs: Record<string, FunctionBlockDef> = {};
  for (const [name, def] of Object.entries(program.fbs ?? {})) {
    fbs[name === oldName ? newName : name] = def;
  }

  const networks = program.networks.map((net) => ({
    ...net,
    rungs: net.rungs.map((rung) => ({
      ...rung,
      series: rung.series.map((el) => renameInElement(el, oldName, newName)),
    })),
  }));

  return { ...program, fbs, networks };
}
