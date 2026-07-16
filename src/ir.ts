/**
 * TypeScript mirror of the Not-a-PLC program IR (the canonical model).
 *
 * These types describe exactly the dict shape produced by the integration's
 * `Program.to_dict` (see `engine/model.py`). The card is a pure consumer of that
 * model — it never invents its own program representation.
 */

export type TagKind = "input" | "coil" | "memory" | "temp";
export type TagType = "BOOL" | "REAL" | "TIME";
export type ContactMode = "NO" | "NC";
export type CoilMode = "=" | "S" | "R";
export type CompareOp = "GT" | "GE" | "LT" | "LE" | "EQ" | "NE";

export interface WritesBinding {
  target: string;
  /** For a REAL coil: the `domain.service` that sets the value (e.g. light.turn_on). */
  service?: string;
  /** For a REAL coil: the service-data key carrying the value (e.g. brightness_pct). */
  value_key?: string;
}

export interface TagDef {
  kind: TagKind;
  type?: TagType;
  source?: string;
  writes?: WritesBinding;
  retain?: boolean;
  on_unavailable?: "false" | "hold";
  true_states?: string[];
}

export interface ContactEl {
  type: "contact";
  tag: string;
  mode?: ContactMode;
}

export interface BranchEl {
  /** OR of one or more series sub-chains. */
  branch: Element[][];
}

export interface NotEl {
  /** Inline power inverter: flips the running series power at its position. */
  type: "not";
}

export interface CompareEl {
  type: "compare";
  op: CompareOp;
  left: string;
  /** Numeric constant, or the name of another REAL tag. */
  right: number | string;
}

export interface FbRefEl {
  type: "fb";
  /** Name of a function-block instance declared in `Program.fbs`. */
  instance: string;
}

export type Element = ContactEl | BranchEl | NotEl | CompareEl | FbRefEl;

export interface Coil {
  type: "coil";
  tag: string;
  mode?: CoilMode;
}

export interface MoveEl {
  type: "move";
  /** Writable REAL destination tag. */
  dst: string;
  /** Numeric constant, a REAL tag, or a function-block output (`inst.ET`/`.CV`). */
  src: number | string;
}

export type CalcOp = "ADD" | "SUB" | "MUL" | "DIV";

export interface CalcEl {
  type: "calc";
  op: CalcOp;
  /** Writable REAL destination tag. */
  dst: string;
  /** Operands: each a numeric constant, a REAL tag, or a fb output. */
  a: number | string;
  b: number | string;
}

/** A rung output: a boolean coil, a REAL move, or a REAL calc. */
export type Output = Coil | MoveEl | CalcEl;

export interface Rung {
  id: string;
  series: Element[];
  coils: Output[];
  title?: string;
}

export interface Network {
  id: string;
  rungs: Rung[];
  title?: string;
}

export interface FunctionBlockDef {
  type: string;
  [key: string]: unknown;
}

export interface Program {
  meta?: Record<string, unknown>;
  scan_interval_ms?: number;
  tags: Record<string, TagDef>;
  fbs?: Record<string, FunctionBlockDef>;
  networks: Network[];
}

/** Process image pushed by `subscribe_state`: tag name -> value. */
export type StateImage = Record<string, boolean | number>;

/** One running Not-a-PLC service, from `list_services`. */
export interface ServiceInfo {
  entry_id: string;
  name: string;
}

// --- Narrowing helpers ------------------------------------------------------

export function isContact(el: Element): el is ContactEl {
  return (el as ContactEl).type === "contact";
}

export function isBranch(el: Element): el is BranchEl {
  return Array.isArray((el as BranchEl).branch);
}

export function isNot(el: Element): el is NotEl {
  return (el as NotEl).type === "not";
}

export function isCompare(el: Element): el is CompareEl {
  return (el as CompareEl).type === "compare";
}

export function isFb(el: Element): el is FbRefEl {
  return (el as FbRefEl).type === "fb";
}

export function isMove(output: Output): output is MoveEl {
  return (output as MoveEl).type === "move";
}

export function isCalc(output: Output): output is CalcEl {
  return (output as CalcEl).type === "calc";
}
