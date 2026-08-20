/*
 * Repro — checklist row 28.9 ("Timestamps are in the user's locale and stay
 * correct across a day boundary") against https://canary.smithers.sh.
 *
 * The locale half holds: stamps follow the browser's timezone. The day-boundary
 * half does not: every transcript stamp is a bare time with no date qualifier,
 * so a message from a previous day is indistinguishable from one sent minutes
 * ago. Driving the clock across midnight with
 * `Emulation.setTimezoneOverride` re-renders the same messages as "11:30 PM"
 * — now yesterday's time — with no "Yesterday" or date added.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.9.ts
 *   exit 1 while the bug is present, 0 once stamps qualify the day.
 */
import { open, run, body } from "./_lib";

/*
 * Two stamps, never one: a /g regex for matchAll (which requires it) and a
 * flagless one for .test(). A shared /g regex makes .test() stateful — its
 * lastIndex survives across calls, so the same line alternates match/no-match
 * and the day-qualifier probe below judged lines by parity, not content.
 */
const STAMP = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/;
const STAMP_GLOBAL = new RegExp(STAMP.source, "g");
const DAY_QUALIFIER = /\b(Yesterday|yesterday|Today|today|\d{4}-\d{2}-\d{2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

const { context, page } = await open();
await run(page, "/billing.balance", 6000);

const homeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
const before = await body(page);
const stampsBefore = [...before.matchAll(STAMP_GLOBAL)].map((m) => m[0]);
console.log("browser timezone:", homeZone);
console.log("stamps as sent  :", JSON.stringify([...new Set(stampsBefore)].slice(0, 6)));

// Push the clock across midnight: the same messages are now on a previous day.
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Kiritimati" }); // UTC+14
await page.waitForTimeout(2000);
await run(page, "/billing.balance", 6000);

const after = await body(page);
const transcript = await page.evaluate(() =>
	Array.from(document.querySelectorAll("[data-role]")).map((m) => (m as HTMLElement).innerText.trim().slice(-40)).slice(0, 8),
);
const stampsAfter = [...after.matchAll(STAMP_GLOBAL)].map((m) => m[0]);
console.log("stamps under UTC+14:", JSON.stringify([...new Set(stampsAfter)].slice(0, 6)));
console.log("transcript tails   :", JSON.stringify(transcript));
console.log("any day qualifier on a stamp:", DAY_QUALIFIER.test(after.split("\n").filter((l) => STAMP.test(l)).join(" ")));
await page.screenshot({ path: "/tmp/canary-28.9.png", fullPage: true });
console.log("screenshot: /tmp/canary-28.9.png");
await context.close();

const followsLocale = JSON.stringify(stampsBefore) !== JSON.stringify(stampsAfter);
const qualified = DAY_QUALIFIER.test(after.split("\n").filter((line) => STAMP.test(line)).join(" "));
const failures: Array<string> = [];
if (!followsLocale) failures.push("stamps did not change with the timezone — they are not rendered in the user's locale.");
if (!qualified) {
	failures.push(
		"every stamp is a bare time with no date or 'Yesterday' qualifier, so a message from a previous day is indistinguishable from one sent minutes ago.",
	);
}
if (failures.length === 0) {
	console.log("PASS — stamps are local and stay correct across a day boundary.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
