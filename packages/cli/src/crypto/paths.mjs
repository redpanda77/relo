// Where this computer keeps sealed content's local copies (card text in sealed-cards/), under the one state
// folder (work/state-file.mjs statePath). A leaf module: every sealing module may import it.
import { statePath } from "../work/state-file.mjs";

/** `place` is a command's { env, home } (its dependencies). */
export function sealedCardDirectory(place) {
  return statePath(place, "sealed-cards");
}
