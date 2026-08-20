/*
 * Checklist §15.6 — `/env.set NAME=value` sets and confirms, "and the value
 * never appears in plain text afterwards".
 *
 * The set half works: the PUT lands and the env card refreshes. The masking
 * half does not. `EnvironmentSeam.setEnvironmentVar` writes into the
 * platform's `env` list (plain variables), never the `secrets` list, so the
 * value comes straight back out of `/env.view` in plain text — on this turn
 * and on every later one.
 *
 * Exits non-zero while the bug is present.
 */
import { open, runFlow, transcript } from "./_lib.ts";

const REPO = "codeplanesmithers/canary-sandbox";
const NAME = "CANARY_ROW156_REPRO";
const VALUE = "fake-value-not-a-secret-19aug";

const { context, page } = await open();
await runFlow(page, `/env.set ${NAME}=${VALUE} ${REPO}`);
await page.waitForTimeout(20_000);
const afterSet = await transcript(page);
await runFlow(page, `/env.view ${REPO}`);
await page.waitForTimeout(15_000);
const afterView = await transcript(page);
await page.screenshot({ path: "/tmp/canary-repro-15.6.png", fullPage: true });
await context.close();

const leakedOnSet = afterSet.includes(VALUE);
const leakedOnView = afterView.includes(VALUE);
console.log(`${NAME} present after /env.set:`, leakedOnSet);
console.log(`${NAME} present after /env.view:`, leakedOnView);

if (leakedOnSet || leakedOnView) {
	console.error(`FAIL 15.6: ${NAME}'s value is rendered in plain text after it is set.`);
	process.exit(1);
}
console.log("PASS 15.6: the value never appears in plain text.");
