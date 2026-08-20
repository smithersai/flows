/*
 * Repro — the model relay answers an over-cap transcript with a raw
 * "Request body is too large.", which names nothing the reader can act on.
 *
 * Every model call replays the whole transcript, so an over-cap body is a fact
 * about the CONVERSATION, not about the message that tripped it. The turn seam
 * (POST /api/agent/turn) already says so; POST /api/model/stream — which
 * carries every turn now that the in-browser chain is the only backend — does
 * not, so the wedge in apps/ui/canary-repros/chat/4.13 still reads as a
 * mechanical refusal with no way out.
 *
 *   bun model-relay-413.ts     exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, ensureSignedIn, PROFILE, report, seam } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
console.log("session:", JSON.stringify(await ensureSignedIn(page)));

const failures: Array<string> = [];
/* 1.1 MB of transcript: over the Worker's 1 MB body cap on either door. */
const oversize = { role: "user", content: "x".repeat(1100 * 1024) };

const relay = await seam(page, "POST", "/api/model/stream", { messages: [oversize] });
console.log(`POST /api/model/stream -> ${relay.status} ${relay.body}`);
if (relay.status !== 413) {
	failures.push(`the relay answered HTTP ${relay.status}, not the 413 an over-cap transcript earns`);
} else if (!relay.body.includes("This conversation has grown too long")) {
	failures.push(`the relay's 413 names no way out: ${relay.body}`);
}

const turn = await seam(page, "POST", "/api/agent/turn", {
	runId: "repro-model-relay-413",
	instructions: "hi",
	messages: [oversize],
});
console.log(`POST /api/agent/turn  -> ${turn.status} ${turn.body}`);
if (turn.status !== 413 || !turn.body.includes("This conversation has grown too long")) {
	failures.push(`the turn seam's 413 regressed: ${turn.status} ${turn.body}`);
}

await context.close();
report(failures);
