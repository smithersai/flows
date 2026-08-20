/** @jsxImportSource smthrs */
import { Monitor, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const { Workflow, smithers, outputs } = createSmithers({
  health: z.strictObject({
    condition: z.enum(["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]),
    runStatus: z.string(),
    ownerActive: z.boolean(),
    targetNodeId: z.string().nullable().default(null),
    evidence: z.string(),
    summary: z.string(),
  }),
  action: z.strictObject({
    action: z.string(),
    changed: z.boolean().default(false),
    summary: z.string(),
  }),
});

export default smithers((ctx: any) => (
  <Workflow name="universal-flow-runtime-swarm-monitor">
    <Monitor
      watchRunId={ctx.input.watchRunId}
      agent={agents.cheapFast}
      healthOutput={outputs.health}
      actionOutput={outputs.action}
      intervalMs={60_000}
    />
  </Workflow>
));
