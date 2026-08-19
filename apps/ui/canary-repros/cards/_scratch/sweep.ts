import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const list: Array<[string,string,number]> = [
  ["8.4","/billing.balance",7000],
  ["8.9","/admin.health",9000],
  ["8.8","/admin.feedback",9000],
  ["8.7","/admin.requests",9000],
  ["8.10","/repos.watch",9000],
  ["8.11","/connect",6000],
  ["8.12","/world",6000],
  ["8.28","/theme",5000],
  ["8.23","/env.view",7000],
  ["8.21","/keys.list",8000],
  ["8.22","/notifications.list",9000],
  ["8.15","/flow.list",9000],
  ["8.16","/flow.repo.choose",9000],
  ["8.17",`/issues.list ${REPO}`,12000],
  ["8.19",`/prs.list ${REPO}`,12000],
  ["8.25",`/branches.list ${REPO}`,12000],
  ["8.26",`/files.list ${REPO}`,12000],
];
const { context, page, session } = await open();
console.log("session:", JSON.stringify(session));
for (const [row, cmd, wait] of list) {
  const before = (await cards(page)).length;
  await send(page, cmd, wait);
  const after = await cards(page);
  console.log(`\n=== ${row} ${cmd} :: total cards ${before} -> ${after.length}`);
  for (const c of after.slice(before)) console.log(`  [${c.kind}] status=${c.status} :: ${c.text.slice(0,300)}`);
  if (after.length === before) {
    const t = await page.locator("body").innerText();
    console.log("  NO NEW CARD. tail: " + t.replace(/\s+/g," ").slice(-400));
  }
}
await page.screenshot({ path: "/tmp/cards-lane/sweep.png", fullPage: true });
await context.close();
