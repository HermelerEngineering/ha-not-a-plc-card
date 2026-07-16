/**
 * Pure helpers for editing the tag table of a program (phase 4.2).
 *
 * These functions are side-effect free and never touch the DOM or `hass`, so
 * they are unit-tested with vitest. The panel wires them to form controls.
 *
 * The canonical rules they encode:
 *   - a tag's type is *inferred* from the bound entity's domain (overridable);
 *   - renaming a tag rewrites every reference to it across the whole IR, so the
 *     program stays valid;
 *   - changing a tag's kind clears the fields that no longer apply.
 */

import {
  BranchEl,
  CompareEl,
  Element,
  FunctionBlockDef,
  Program,
  TagDef,
  TagKind,
  TagType,
  isBranch,
  isCalc,
  isCompare,
  isContact,
  isMove,
} from "./ir";

/** Entity domains offered per tag type. See project-plan §3a. */
export const REAL_DOMAINS = ["sensor", "input_number", "number"];
export const BOOL_DOMAINS = [
  "binary_sensor",
  "input_boolean",
  "switch",
  "light",
  "fan",
  "sun",
  "person",
  "device_tracker",
  "cover",
  "lock",
  "group",
];

/** The entity domains that fit a tag of the given type. */
export function domainsForType(type: TagType): string[] {
  return type === "REAL" ? REAL_DOMAINS : BOOL_DOMAINS;
}

/**
 * Infer a tag type from a bound entity_id's domain: numeric domains map to
 * REAL, everything else to BOOL. The result is a sensible default the user can
 * still override. (A non-numeric `sensor` is rare here and is easily corrected.)
 */
export function inferType(entityId: string): TagType {
  const domain = entityId.split(".")[0];
  return REAL_DOMAINS.includes(domain) ? "REAL" : "BOOL";
}

/** Fields on a tag that only make sense for a specific kind. */
function normaliseForKind(tag: TagDef, kind: TagKind): TagDef {
  const next: TagDef = { kind, type: tag.type ?? "BOOL" };
  if (kind === "input") {
    if (tag.source !== undefined) next.source = tag.source;
    next.on_unavailable = tag.on_unavailable ?? "false";
    if (tag.true_states !== undefined) next.true_states = tag.true_states;
  } else if (kind === "coil") {
    if (tag.writes !== undefined) next.writes = tag.writes;
  } else if (kind === "memory") {
    if (tag.retain) next.retain = true;
  }
  // "temp" keeps only kind + type.
  return next;
}

/** Change a tag's kind, dropping fields that no longer apply. */
export function setKind(tag: TagDef, kind: TagKind): TagDef {
  return normaliseForKind(tag, kind);
}

/** Whether `name` is referenced by any element, coil or fb in the program. */
export function isTagReferenced(program: Program, name: string): boolean {
  const inElement = (el: Element): boolean => {
    if (isContact(el)) return el.tag === name;
    if (isCompare(el)) return el.left === name || el.right === name;
    if (isBranch(el)) return el.branch.some((p) => p.some(inElement));
    // NOT is an inline leaf and FbRef references an fb instance — neither a tag.
    return false;
  };
  for (const net of program.networks) {
    for (const rung of net.rungs) {
      if (rung.series.some(inElement)) return true;
      const inOutput = rung.coils.some((c) => {
        if (isMove(c)) return c.dst === name || c.src === name;
        if (isCalc(c)) return c.dst === name || c.a === name || c.b === name;
        return c.tag === name;
      });
      if (inOutput) return true;
    }
  }
  for (const fb of Object.values(program.fbs ?? {})) {
    if (fb.reset === name || fb.load === name) return true;
  }
  return false;
}

/** Rewrite every reference to `oldName` as `newName` inside one element. */
function renameInElement(el: Element, oldName: string, newName: string): Element {
  if (isContact(el)) {
    return el.tag === oldName ? { ...el, tag: newName } : el;
  }
  if (isCompare(el)) {
    const next: CompareEl = { ...el };
    if (next.left === oldName) next.left = newName;
    if (next.right === oldName) next.right = newName;
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
  return el; // NOT (inline leaf) and FbRef carry no tag reference
}

/**
 * Rename a tag, rewriting every reference to it across the IR (contacts, coils,
 * compare operands and fb `reset`/`load` params) so the program stays valid.
 * Returns the program unchanged when the rename is a no-op or would collide.
 */
export function renameTag(program: Program, oldName: string, newName: string): Program {
  if (newName === oldName) return program;
  if (!newName || newName in program.tags) return program;

  const tags: Record<string, TagDef> = {};
  for (const [name, tag] of Object.entries(program.tags)) {
    tags[name === oldName ? newName : name] = tag;
  }

  const fbs: Record<string, FunctionBlockDef> = {};
  for (const [name, fb] of Object.entries(program.fbs ?? {})) {
    const next: FunctionBlockDef = { ...fb };
    if (next.reset === oldName) next.reset = newName;
    if (next.load === oldName) next.load = newName;
    fbs[name] = next;
  }

  const networks = program.networks.map((net) => ({
    ...net,
    rungs: net.rungs.map((rung) => ({
      ...rung,
      series: rung.series.map((el) => renameInElement(el, oldName, newName)),
      coils: rung.coils.map((c) => {
        if (isMove(c)) {
          const next = { ...c };
          if (next.dst === oldName) next.dst = newName;
          if (next.src === oldName) next.src = newName;
          return next;
        }
        if (isCalc(c)) {
          const next = { ...c };
          if (next.dst === oldName) next.dst = newName;
          if (next.a === oldName) next.a = newName;
          if (next.b === oldName) next.b = newName;
          return next;
        }
        return c.tag === oldName ? { ...c, tag: newName } : c;
      }),
    })),
  }));

  const result: Program = { ...program, tags, networks };
  if (program.fbs) result.fbs = fbs;
  return result;
}

/** A fresh unique tag name like `tag`, `tag_2`, `tag_3`, … */
export function freshTagName(program: Program, base = "tag"): string {
  if (!(base in program.tags)) return base;
  let i = 2;
  while (`${base}_${i}` in program.tags) i += 1;
  return `${base}_${i}`;
}

/** Add a new default tag (memory/BOOL) and return the updated program. */
export function addTag(program: Program): { program: Program; name: string } {
  const name = freshTagName(program);
  const tag: TagDef = { kind: "memory", type: "BOOL" };
  return {
    program: { ...program, tags: { ...program.tags, [name]: tag } },
    name,
  };
}

/** Remove a tag (references, if any, are caught by save-time validation). */
export function removeTag(program: Program, name: string): Program {
  const tags = { ...program.tags };
  delete tags[name];
  return { ...program, tags };
}

/** Replace one tag's definition, returning the updated program. */
export function setTag(program: Program, name: string, tag: TagDef): Program {
  return { ...program, tags: { ...program.tags, [name]: tag } };
}
