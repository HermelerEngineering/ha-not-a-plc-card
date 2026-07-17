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

import {
  Element,
  Output,
  Program,
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
      // A function-block numeric output like "t1.ET" / "c1.CV".
      const inst = val.split(".")[0];
      return inst in fbs ? null : `references unknown function block "${inst}"`;
    }
    return val in tags ? null : `references unknown tag "${val}"`;
  };

  program.networks.forEach((net, ni) => {
    net.rungs.forEach((rung, ri) => {
      const location = `${net.id || `N${ni + 1}`} · ${rung.id || `R${ri + 1}`}`;
      const add = (level: IssueLevel, message: string) =>
        issues.push({ level, ni, ri, location, message });

      const walkEl = (el: Element): void => {
        if (isContact(el)) {
          const p = refProblem(el.tag);
          if (p) add("error", `contact ${p}`);
        } else if (isCompare(el)) {
          const lp = refProblem(el.left);
          if (lp) add("error", `compare left operand ${lp}`);
          const rp = refProblem(el.right);
          if (rp) add("error", `compare right operand ${rp}`);
        } else if (isFb(el)) {
          if (!el.instance) add("error", "function block not selected");
          else if (!(el.instance in fbs))
            add("error", `references unknown function block "${el.instance}"`);
        } else if (isBranch(el)) {
          el.branch.forEach((path, pi) => {
            if (path.length === 0) add("error", `branch OR-path ${pi + 1} is empty`);
            path.forEach(walkEl);
          });
        }
        // NOT is a leaf: nothing to reference.
      };
      rung.series.forEach(walkEl);

      if (rung.coils.length === 0) {
        add("warning", "rung has no output (coil / move / calc)");
      }
      rung.coils.forEach((out: Output) => {
        if (isMove(out)) {
          const dp = refProblem(out.dst);
          if (dp) add("error", `move target ${dp}`);
          const sp = refProblem(out.src);
          if (sp) add("error", `move source ${sp}`);
        } else if (isCalc(out)) {
          const dp = refProblem(out.dst);
          if (dp) add("error", `calc target ${dp}`);
          const ap = refProblem(out.a);
          if (ap) add("error", `calc operand A ${ap}`);
          const bp = refProblem(out.b);
          if (bp) add("error", `calc operand B ${bp}`);
        } else {
          const p = refProblem(out.tag);
          if (p) add("error", `coil ${p}`);
        }
      });
    });
  });

  return issues;
}
