/**
 * Pure helpers for editing the *structure* of a program (phase 4.3):
 * networks, rungs, top-level series elements and coils.
 *
 * Like `tags.ts` these are side-effect free and unit-tested with vitest; the
 * panel wires them to forms. They operate immutably (always returning a new
 * `Program`) and address targets by index: `ni` = network index, `ri` = rung
 * index within that network, `ei`/`ci` = element/coil index within that rung.
 *
 * Scope note: element ops act on the *top level* of a rung's series. Editing the
 * contents of a branch or NOT group (nested series) is a later sub-phase; those
 * stay editable via the DSL text escape hatch until then.
 */

import {
  Coil,
  CoilMode,
  CompareEl,
  CompareOp,
  ContactEl,
  ContactMode,
  Element,
  FbRefEl,
  Network,
  Program,
  Rung,
} from "./ir";

// --- immutable array helpers ------------------------------------------------

function mapAt<T>(arr: T[], i: number, fn: (item: T) => T): T[] {
  return arr.map((item, idx) => (idx === i ? fn(item) : item));
}

function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, idx) => idx !== i);
}

function moveItem<T>(arr: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(i, 1);
  next.splice(j, 0, item);
  return next;
}

/** The lowest-numbered fresh `<prefix><n>` id (n≥1) not present in `existing`. */
export function freshId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// --- constructors -----------------------------------------------------------

export function newContact(tag = "", mode: ContactMode = "NO"): ContactEl {
  return { type: "contact", tag, mode };
}

export function newCompare(
  left = "",
  op: CompareOp = "GT",
  right: number | string = 0,
): CompareEl {
  return { type: "compare", op, left, right };
}

export function newFbRef(instance = ""): FbRefEl {
  return { type: "fb", instance };
}

export function newCoil(tag = "", mode: CoilMode = "="): Coil {
  return { type: "coil", tag, mode };
}

export function newRung(id: string): Rung {
  return { id, series: [], coils: [] };
}

export function newNetwork(id: string, rungId: string): Network {
  return { id, rungs: [newRung(rungId)] };
}

// --- network ops ------------------------------------------------------------

function withNetworks(program: Program, networks: Network[]): Program {
  return { ...program, networks };
}

export function addNetwork(program: Program): Program {
  const id = freshId(
    program.networks.map((n) => n.id),
    "n",
  );
  return withNetworks(program, [...program.networks, newNetwork(id, "r1")]);
}

export function removeNetwork(program: Program, ni: number): Program {
  return withNetworks(program, removeAt(program.networks, ni));
}

export function moveNetwork(program: Program, ni: number, delta: number): Program {
  return withNetworks(program, moveItem(program.networks, ni, delta));
}

export function setNetworkTitle(program: Program, ni: number, title: string): Program {
  return withNetworks(
    program,
    mapAt(program.networks, ni, (n) => ({ ...n, title: title || undefined })),
  );
}

// --- rung ops ---------------------------------------------------------------

function withRungs(program: Program, ni: number, rungs: Rung[]): Program {
  return withNetworks(program, mapAt(program.networks, ni, (n) => ({ ...n, rungs })));
}

export function addRung(program: Program, ni: number): Program {
  const net = program.networks[ni];
  if (!net) return program;
  const id = freshId(
    net.rungs.map((r) => r.id),
    "r",
  );
  return withRungs(program, ni, [...net.rungs, newRung(id)]);
}

export function removeRung(program: Program, ni: number, ri: number): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(program, ni, removeAt(net.rungs, ri));
}

export function moveRung(
  program: Program,
  ni: number,
  ri: number,
  delta: number,
): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(program, ni, moveItem(net.rungs, ri, delta));
}

export function setRungTitle(
  program: Program,
  ni: number,
  ri: number,
  title: string,
): Program {
  const net = program.networks[ni];
  if (!net) return program;
  return withRungs(
    program,
    ni,
    mapAt(net.rungs, ri, (r) => ({ ...r, title: title || undefined })),
  );
}

// --- element + coil ops (top level of a rung's series) ----------------------

function updateRungAt(
  program: Program,
  ni: number,
  ri: number,
  fn: (rung: Rung) => Rung,
): Program {
  const net = program.networks[ni];
  if (!net || !net.rungs[ri]) return program;
  return withRungs(program, ni, mapAt(net.rungs, ri, fn));
}

export function addElement(
  program: Program,
  ni: number,
  ri: number,
  el: Element,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({ ...r, series: [...r.series, el] }));
}

export function removeElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    series: removeAt(r.series, ei),
  }));
}

export function updateElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
  el: Element,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    series: mapAt(r.series, ei, () => el),
  }));
}

export function moveElement(
  program: Program,
  ni: number,
  ri: number,
  ei: number,
  delta: number,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    series: moveItem(r.series, ei, delta),
  }));
}

export function addCoil(
  program: Program,
  ni: number,
  ri: number,
  coil: Coil,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({ ...r, coils: [...r.coils, coil] }));
}

export function removeCoil(
  program: Program,
  ni: number,
  ri: number,
  ci: number,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({ ...r, coils: removeAt(r.coils, ci) }));
}

export function updateCoil(
  program: Program,
  ni: number,
  ri: number,
  ci: number,
  coil: Coil,
): Program {
  return updateRungAt(program, ni, ri, (r) => ({
    ...r,
    coils: mapAt(r.coils, ci, () => coil),
  }));
}
