import { open, send } from "./drv.ts";
const REPO = "codeplanesmithers/canary-sandbox";
const { context, page } = await open({ width: 1280, height: 950 });
const net: string[] = [];
page.on("response", r => { const u=r.url(); if (u.includes("/api/") && r.status()>=400) net.push(`${r.status()} ${u}`); });
const step = async (cmd: string, wait=12000) => {
  const before = await page.evaluate(()=>({n:document.querySelectorAll("[data-kind]").length, t:(document.querySelector(".sui-chat-messages") as HTMLElement)?.innerText ?? ""}));
  net.length = 0;
  await send(page, cmd, wait);
  const after = await page.evaluate((b)=>({
    newCards: Array.from(document.querySelectorAll("[data-kind]")).slice(b).map(e=>({k:e.getAttribute("data-kind"),s:e.getAttribute("data-status"),t:(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,300),acts:Array.from(e.querySelectorAll("button")).map(x=>(x as HTMLElement).innerText.trim()).filter(Boolean)})),
    full:(document.querySelector(".sui-chat-messages") as HTMLElement)?.innerText ?? "",
  }), before.n);
  const delta = after.full.slice(before.t.length).trim();
  console.log(`\n### ${cmd}\n  4xx: ${JSON.stringify(net)}\n  newCards: ${JSON.stringify(after.newCards)}\n  newText: ${JSON.stringify(delta.slice(0,400))}`);
};
await step(`/files.list . ${REPO}`, 20000);
await step(`/files.read does-not-exist.txt ${REPO}`);
await step(`/prs.view 99 ${REPO}`);
await step(`/issues.view 9999 ${REPO}`);
await step(`/repos.import codeplanesmithers/no-such-repo-canary-xyz`, 15000);
await step(`/branches.list codeplanesmithers/no-such-repo-canary-xyz`);
await page.screenshot({path:"/tmp/cards-lane/77.png", fullPage:true});
await context.close();
