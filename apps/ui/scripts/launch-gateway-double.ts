/*
 * Wave 6: the labeled gateway TEST DOUBLE for the local full-stack baseline.
 * The dev stack (flows/ui scripts/dev-stack.sh) runs no engine gateway, so
 * the product Worker's gateway seam points at this double for the baseline
 * run — the same double the worker e2e uses (createStubGateway binds an
 * ephemeral port and prints it; pass the printed origin to wrangler as
 * --var GATEWAY_UPSTREAM_URL:http://127.0.0.1:<port>). Never deploy this.
 *
 *   bun scripts/launch-gateway-double.ts
 */
import { createStubGateway } from "./stub-backends";

const gateway = createStubGateway();
console.log(`gateway TEST DOUBLE on http://127.0.0.1:${gateway.port}`);
console.log("routes: POST /v1/rpc/submitApproval (echo), GET /stub/last-approval, POST /stub/fail-approval");
