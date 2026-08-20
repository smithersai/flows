import { open, api } from "./drv.ts";
const { context, page } = await open();
for (const p of ["/api/admin/feedback", "/api/admin/feedback?login=codeplanesmithers"]) {
  const r = await api(page, p);
  console.log("GET", p, r.status, r.body.slice(0, 600));
}
const d = await api(page, "/api/admin/reco-dismissals?login=codeplanesmithers", { method: "DELETE" });
console.log("DELETE dismissals", d.status, d.body.slice(0, 400));
await context.close();
