// Three-line refusals (plan 04 §0.3): what went wrong, the state, the exact next command.
import { EXIT, ReloError } from "../errors.mjs";

export class WorkRefusal extends ReloError {
  constructor(code, { what, state, next, exitCode = EXIT.USAGE, details } = {}) {
    super(`Refused: ${what}.`, { code, exitCode, details });
    this.what = what;
    this.state = state;
    this.next = next;
  }
}

export function refusalText(r) {
  return `Refused: ${r.what}.\nState: ${r.state}.\nNext: ${r.next}`;
}
