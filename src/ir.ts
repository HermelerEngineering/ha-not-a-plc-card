/**
 * TypeScript mirror of the Not a PLC program IR (the canonical model).
 *
 * These types describe exactly the dict shape produced by the integration's
 * `Program.to_dict` (see `engine/model.py`). The card is a pure consumer of that
 * model — it never invents its own program representation.
 */

export type TagKind = "input" | "coil" | "memory";
export type TagType = "BOOL" | "REAL" | "TIME";
export type ContactMode = "NO" | "NC";
export type CoilMode = "=" | "S" | "R";

export interface WritesBinding {
  target: string;
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
  /** Negation of an inner series chain. */
  not: Element[];
}

export type Element = ContactEl | BranchEl | NotEl;

export interface Coil {
  type: "coil";
  tag: string;
  mode?: CoilMode;
}

export interface Rung {
  id: string;
  series: Element[];
  coils: Coil[];
  title?: string;
}

export interface Network {
  id: string;
  rungs: Rung[];
  title?: string;
}

export interface Program {
  meta?: Record<string, unknown>;
  scan_interval_ms?: number;
  tags: Record<string, TagDef>;
  networks: Network[];
}

/** Process image pushed by `subscribe_state`: tag name -> value. */
export type StateImage = Record<string, boolean | number>;

/** One running Not a PLC service, from `list_services`. */
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
  return Array.isArray((el as NotEl).not);
}
