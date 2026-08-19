import { open, send, cards } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 390, height: 844 });
const cmds = [
  "/billing.balance","/admin.health","/admin.feedback","/admin.requests","/theme",
  `/issues.list ${REPO}`,`/prs.list ${REPO}`,`/branches.list ${REPO}`,`/files.list . ${REPO}`,
  `/env.view ${REPO}`,"/notifications.list",`/issues.view 1 ${REPO}`,`/prs.view 2 ${REPO}`,
  `/files.read README.md ${REPO}`,"/repos.import codeplanesmithers/no-such-repo-canary-xyz",
];
for (const c of cmds) await send(page, c, 9000);
const report = await page.evaluate(() => {
  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-kind]"))) {
    const pills = Array.from(el.querySelectorAll('span.sui-badge')) as HTMLElement[];
    const pill = pills.find(p => /RUNNING|DONE|FAILED|WAITING|PENDING|BLOCKED|APPROV/i.test(p.innerText)) ?? pills[0] ?? null;
    const header = el.querySelector('[data-slot="card-header"], header') as HTMLElement | null;
    const info: any = { kind: el.getAttribute("data-kind"), status: el.getAttribute("data-status") };
    if (pill) {
      const r = pill.getBoundingClientRect();
      info.pillText = pill.innerText.trim();
      info.pillW = Math.round(r.width); info.pillScrollW = pill.scrollWidth; info.pillClientW = pill.clientWidth;
      info.pillClipped = pill.scrollWidth > pill.clientWidth + 1;
      info.pillRight = Math.round(r.right); info.pillX = Math.round(r.x);
    } else info.pillText = "(none)";
    if (header) { info.headerScrollW = header.scrollWidth; info.headerClientW = header.clientWidth; }
    const er = el.getBoundingClientRect();
    info.cardRight = Math.round(er.right); info.cardX = Math.round(er.x);
    out.push(info);
  }
  return { vw: window.innerWidth, docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth, cards: out };
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: "/tmp/cards-lane/73-narrow.png", fullPage: true });
await context.close();
