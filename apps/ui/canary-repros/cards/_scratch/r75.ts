import { open, send } from "./drv.ts";
const { context, page } = await open({ width: 1280, height: 950 });
const order = async () => page.evaluate(() => {
  const root = document.querySelector(".sui-chat-messages") ?? document.body;
  return Array.from(root.children).map((e) => {
    const c = e.matches("[data-kind]") ? e : e.querySelector("[data-kind]");
    if (c) return `card:${c.getAttribute("data-kind")}`;
    return `msg:${(e as HTMLElement).innerText.trim().slice(0,28).replace(/\s+/g," ")}`;
  });
});
await send(page, "/billing.balance", 7000);
await send(page, "hello one", 25000);
await send(page, "/theme", 6000);
await send(page, "hello two", 25000);
await send(page, "/notifications.list", 9000);
const before = await order();
console.log("before reload:", JSON.stringify(before));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const after = await order();
console.log("after reload: ", JSON.stringify(after));
console.log("same:", JSON.stringify(before)===JSON.stringify(after));
const expect = ["card:balance","msg:hello one","card:theme-picker","msg:hello two","card:notifications"];
const idx = expect.map(e => after.findIndex(x => x.startsWith(e)));
console.log("indices:", JSON.stringify(idx), "monotonic:", idx.every((v,i)=> v>=0 && (i===0||v>idx[i-1])));
await context.close();
