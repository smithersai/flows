/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react"
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui"

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    title="Isomorphic component library port"
    description="Copy @smthrs/ui into this repo as a provider-injected isomorphic library: one platform-agnostic component API, a react-dom provider and an @opentui/react provider. Foundation lands first, then eight parallel codex lanes port the library by directory into isolated worktrees, then integration swaps apps/ui with its existing test suite unchanged."
  />,
)
