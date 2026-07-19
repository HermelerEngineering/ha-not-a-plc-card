/**
 * Client-side program validation for inline editor feedback (phase 4.5).
 *
 * Pure and lit-free so it can be unit-tested. It reports the *actionable,
 * unambiguously-broken* things a freshly-built program tends to have — empty or
 * dangling references, and rungs with no output — so the user sees them before
 * saving instead of hitting a backend `invalid_program` error. It is deliberately
 * conservative (it never flags something the backend would accept); the backend's
 * `Program.from_dict` remains the authority on save, including type-level rules
 * this does not check (e.g. a compare operand must be REAL).
 */

import { SeriesStep } from "./elements";
import { fbNumericOutputs, isSourceType } from "./fbs";
import {
  Element,
  Output,
  Program,
  isAction,
  isBranch,
  isCalc,
  isCompare,
  isContact,
  isFb,
  isMove,
} from "./ir";

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  level: IssueLevel;
  ni: number;
  ri: number;
  /** Human-readable rung location, e.g. "n1 · r2". */
  location: string;
  message: string;
  /** For a series-element issue: the path + index of the flagged element. */
  steps?: SeriesStep[];
  ei?: number;
  /** For a coil/output issue: the output index. */
  ci?: number;
}

export function validateProgram(program: Program): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tags = program.tags ?? {};
  const fbs = program.fbs ?? {};

  /** Describe what's wrong with a tag/operand reference, or null if it's fine. */
  const refProblem = (val: number | string): string | null => {
    if (typeof val === "number") return null; // a numeric constant
    if (val === "") return "is empty";
    if (val.includes(".")) {
      // A function-block numeric output like "t1.ET" / "c1.CV" / "clock.TOD".
      const [inst, out] = val.split(".");
      if (!(inst in fbs)) return `references unknown function block "${inst}"`;
      const outs = fbNumericOutputs(fbs[inst].type);
      if (outs.includes(out)) return null;
      const hint = outs.length ? ` — try ${outs.join(", ")}` : "";
      return `references "${out}", which ${inst} (${fbs[inst].type}) does not have${hint}`;
    }
    return val in tags ? null : `references unknown tag "${val}"`;
  };

  program.networks.forEach((net, ni) => {
    net.rungs.forEach((rung, ri) => {
      const location = `${net.id || `N${ni + 1}`} · ${rung.id || `R${ri + 1}`}`;
      const add = (
        level: IssueLevel,
        message: string,
        pos?: { steps?: SeriesStep[]; ei?: number; ci?: number },
      ) => issues.push({ level, ni, ri, location, message, ...pos });

      const walkEl = (el: Element, steps: SeriesStep[], ei: number): void => {
        const at = { steps, ei };
        if (isContact(el)) {
          const p = refProblem(el.tag);
          if (p) add("error", `contact ${p}`, at);
        } else if (isCompare(el)) {
          const lp = refProblem(el.left);
          if (lp) add("error", `compare left operand ${lp}`, at);
          const rp = refProblem(el.right);
          if (rp) add("error", `compare right operand ${rp}`, at);
        } else if (isFb(el)) {
          if (!el.instance) add("error", "function block not selected", at);
          else if (!(el.instance in fbs))
            add("error", `references unknown function block "${el.instance}"`, at);
          else if (isSourceType(fbs[el.instance].type))
            // A source block has no rung input; it is used via its outputs.
            add(
              "error",
              `a ${fbs[el.instance].type} block is not placed in a rung — ` +
                `compare against its outputs instead (e.g. ${el.instance}.TOD)`,
              at,
            );
        } else if (isBranch(el)) {
          el.branch.forEach((path, pi) => {
            if (path.length === 0) add("error", `branch OR-path ${pi + 1} is empty`, at);
            path.forEach((sub, si) =>
              walkEl(sub, [...steps, { index: ei, path: pi }], si),
            );
          });
        }
        // NOT is a leaf: nothing to reference.
      };
      rung.series.forEach((el, ei) => walkEl(el, [], ei));

      if (rung.coils.length === 0) {
        add("warning", "rung has no output (coil / move / calc)");
      }
      rung.coils.forEach((out: Output, ci) => {
        const at = { ci };
        if (isAction(out)) {
          if (!out.service || !out.service.includes(".")) {
            add("error", "service call needs a domain.service", at);
          }
        } else if (isMove(out)) {
          const dp = refProblem(out.dst);
          if (dp) add("error", `move target ${dp}`, at);
          const sp = refProblem(out.src);
          if (sp) add("error", `move source ${sp}`, at);
        } else if (isCalc(out)) {
          const dp = refProblem(out.dst);
          if (dp) add("error", `calc target ${dp}`, at);
          const ap = refProblem(out.a);
          if (ap) add("error", `calc operand A ${ap}`, at);
          const bp = refProblem(out.b);
          if (bp) add("error", `calc operand B ${bp}`, at);
        } else {
          const p = refProblem(out.tag);
          if (p) add("error", `coil ${p}`, at);
        }
      });
    });
  });

  return issues;
}
