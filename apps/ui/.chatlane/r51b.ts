import { launch, resetStore, composer } from "./lib.ts";
const { ctx, page } = await launch();
for (let round = 1; round <= 3; round++) {
  await resetStore(ctx, page);
  await composer(page).click();
  await page.mouse.move(1350, 20);
  await composer(page).fill("");
  await page.keyboard.type("/", { delay: 40 });
  await page.waitForTimeout(1000);
  const list = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((e,i) => `${i}${e.getAttribute("aria-selected")==="true"?"*":" "}${e.getAttribute("data-gold")==="true"?"G":" "} ${(e as HTMLElement).innerText.replace(/\s+/g," ").slice(0,48)}`));
  console.log(`ROUND ${round} listing:\n  ` + list.join("\n  "));
  const before = await page.locator("body").innerText();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(7000);
  const after = await page.locator("body").innerText();
  const ran = (after.match(/Smithers ran \/[a-z.\-]+/g) ?? []).slice(-1)[0] ?? "(no 'Smithers ran' marker)";
  console.log(`ROUND ${round} Enter -> ${ran}`);
  console.log(`ROUND ${round} tail: ${after.replace(/\s+/g," ").slice(-260)}`);
}
await page.screenshot({ path: "/tmp/chatlane/5.1.png" });
await ctx.close();
