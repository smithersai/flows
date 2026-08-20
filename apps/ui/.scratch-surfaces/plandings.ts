import { open, api } from "./drv.ts";
const { context, page } = await open();
for (const p of ["/api/repos/codeplanesmithers/canary-sandbox/landings?limit=20","/api/repos/codeplanesmithers/canary-sandbox/landings/2"]) {
  const r = await api(page, p);
  console.log("GET", p, r.status, r.body.slice(0, 900));
}
await context.close();
