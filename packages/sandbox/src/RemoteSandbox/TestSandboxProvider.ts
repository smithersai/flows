/**
 * Defines the observable remote sandbox test provider.
 *
 * @since 0.1.0
 */
import type { Provider } from "./Provider.ts"
import type { TestSandboxState } from "./TestSandboxState.ts"

/**
 * A scripted provider plus its observable cancellation state.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSandboxProvider extends Provider {
  readonly state: TestSandboxState
}
