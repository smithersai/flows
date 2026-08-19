/**
 * The shared consensus conformance contract instantiated for the default
 * database-backed strategy, whose lease lives in `flows_consensus_leases` and
 * whose guard joins the append transaction.
 */
import * as SqlConsensus from "../src/SqlConsensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("SqlConsensus.layer", SqlConsensus.layer)
