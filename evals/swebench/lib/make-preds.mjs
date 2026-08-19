/**
 * Builds the official evaluator's predictions file from collected patches.
 *
 *   node lib/make-preds.mjs <patches-dir> <model-name> <instance_id>...
 *
 * A missing patch file is an empty prediction, which the evaluator grades as
 * `empty patch` — the same verdict the rig reports for an agent that changed
 * nothing.
 */
import { existsSync, readFileSync } from "node:fs"

const [, , patchesDir, modelName, ...ids] = process.argv
const preds = {}
for (const id of ids) {
  const path = `${patchesDir}/${id}.patch`
  preds[id] = {
    instance_id: id,
    model_name_or_path: modelName,
    model_patch: existsSync(path) ? readFileSync(path, "utf8") : ""
  }
}
process.stdout.write(JSON.stringify(preds, null, 2))
