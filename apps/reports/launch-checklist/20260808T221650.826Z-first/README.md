# What this archived run actually is

**This run did not reach a running product stack. It proves nothing about the product.**

- Target: `http://127.0.0.1:9` — a dead port, not a product origin.
- Totals: 0 pass · 0 fail · 31 not-testable-yet.
- Every row's reason is `no automated check for this row executed in this run`.

The report files are archived verbatim because the checklist harness emitted them, and
because the shape of the artifact (31 rows, §A–§F, the `not-testable-yet` bucket) is
itself worth having on record. But read the numbers correctly: **`0 fail` here means
"nothing ran", not "nothing is broken."** No row in this archive may be cited as
evidence that a checklist item passes.

A real first-contact run requires the stack from `/Users/williamcory/flows/ui`
(branch `wave5-billing-bridge`, present and clean at the time of writing):

```
scripts/dev-stack.sh                  # four sibling workers, health-checked
bun x wrangler dev                    # product Worker, with the printed env block
SMITHERS_MVP_BASE_URL=<product origin> npm run test:launch-checklist
```

Until an archive exists whose `target` is a real product origin and whose totals are
non-zero, the launch checklist is **unrun**.
