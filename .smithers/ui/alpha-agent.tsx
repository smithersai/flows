/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react"
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui"

// Live dashboard for the alpha-agent production-readiness run: seven parallel
// implementation lanes with one codex sol pre-merge review each, a serialized
// merge queue landing on main immediately, post-land polish loops to explicit
// LGTM, an opus evals lane, a two-verifier production-readiness panel, and a
// durable human gate for H1-H3 ratification.
createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="alpha-agent"
    title="Flows agent layer: production readiness"
    promptPlaceholder="Optional carried findings to seed a fresh run (leave empty for the standard track)"
    inputFromPrompt={(prompt) => ({ carriedFindings: prompt })}
  />,
)
