# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: section-a-first-run.spec.ts >> [A] first run >> signed in >> [A-8] one recommendation card carries proposes / why-now / what-happens / accept-edit-dismiss
- Location: e2e/launch-checklist/section-a-first-run.spec.ts:225:5

# Error details

```
Error: [A-8] no card carries proposes/why-now/what-happens with accept/edit/dismiss controls. card 0: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false | card 1: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=e5]:
  - generic [ref=e6]:
    - button "Show your balance" [ref=e7] [cursor=pointer]: $500
    - button "Toggle theme" [ref=e8] [cursor=pointer]
  - log "Conversation" [ref=e11]:
    - region "Conversation messages" [ref=e13]:
      - generic [ref=e14]:
        - article [ref=e15]:
          - generic [ref=e16]:
            - generic [ref=e17]:
              - generic [ref=e18]: S
              - text: Smithers
            - paragraph [ref=e21]: "You have 5 open issues and 1 open pull request across 3 repos. 6 have been waiting more than a week. The oldest is pull request \"Canary: read-only repository summary\" in codeplanesmithers/canary-sandbox, waiting 26 days."
            - time [ref=e22]: 12:35 PM
            - button "Copy message" [ref=e24] [cursor=pointer]
        - region "What I found" [ref=e28]:
          - generic [ref=e29]:
            - generic [ref=e30]: What I found
            - generic [ref=e31]: Waiting for approval
            - generic [ref=e33]: reco · 12:35 PM
            - button "Maximize card" [ref=e34] [cursor=pointer]
          - generic "Your GitHub digest" [ref=e41]:
            - group [ref=e42]:
              - generic "The read behind this" [ref=e43]
            - paragraph [ref=e44]: Nothing needs you right now.
        - article [ref=e45]:
          - generic [ref=e46]:
            - paragraph [ref=e48]: What do you recommend I do first?
            - time [ref=e49]: 12:35 PM
            - button "Copy message" [ref=e51] [cursor=pointer]
        - article [ref=e55]:
          - generic [ref=e56]:
            - generic [ref=e57]:
              - generic [ref=e58]: S
              - text: Smithers
            - generic [ref=e60]:
              - status "Reasoning status" [ref=e61]: Reasoning complete
              - button "Reasoning" [ref=e62] [cursor=pointer]:
                - generic [ref=e63]: ›
            - generic [ref=e65]:
              - paragraph [ref=e66]: "Here’s a quick snapshot of your current workload:"
              - paragraph [ref=e67]:
                - text: "| Repo | Open Issues | Open PRs | Oldest Open Item ||------|-------------|----------|------------------||"
                - strong [ref=e68]: repo‑1
                - text: "| 2 | 0 | Issue “Fix login redirect” – 12 days ||"
                - strong [ref=e69]: repo‑2
                - text: "| 1 | 1 | PR “Add analytics middleware” – 14 days ||"
                - strong [ref=e70]: repo‑3
                - text: "| 2 | 0 | Issue “Update CI pipeline” – 9 days |"
              - paragraph [ref=e71]:
                - strong [ref=e72]: "Recommendation:"
                - text: "Start by tackling the oldest open pull request – “Canary: read‑only repository summary” in"
                - code [ref=e73]: codeplanesmithers/canary‑sandbox
                - text: (26 days old). Closing that PR will clear the longest‑standing item and free up reviewers. After that, pick the next‑oldest issue or PR from the table.
            - time [ref=e74]: 12:35 PM
            - button "Copy message" [ref=e76] [cursor=pointer]
        - generic [ref=e80]: Smithers checked what it can do here
        - region "World" [ref=e82]:
          - generic [ref=e83]:
            - generic [ref=e84]: World
            - generic [ref=e85]: Done
            - generic [ref=e87]: world · 12:35 PM
            - button "Maximize card" [ref=e88] [cursor=pointer]
          - list [ref=e95]:
            - listitem [ref=e96]:
              - generic [ref=e99]: World
              - generic [ref=e100]: World.md
              - generic [ref=e101]: 100%
        - generic [ref=e102]: Smithers ran /world
  - generic [ref=e104]:
    - group "Suggestions"
    - generic [ref=e105]:
      - textbox "Chat message" [active] [ref=e106]:
        - /placeholder: Ask Smithers to work on something…
      - generic [ref=e108]:
        - button "Surfaces" [ref=e111] [cursor=pointer]
        - button "Send message" [disabled] [ref=e116]:
          - generic [ref=e117]: ↑
```

# Test source

```ts
  158 |     test("[A-5] \"$500 of usage on us\" is stated exactly once", async ({ page }) => {
  159 |       await page.goto("/")
  160 |       // The balance chip lands with the boot's billing refresh; wait for it
  161 |       // rather than racing it — if the offer never renders, that is the fail.
  162 |       const mentions = page.getByText(/\$500/)
  163 |       try {
  164 |         await mentions.first().waitFor({ state: "visible", timeout: 30_000 })
  165 |       } catch {
  166 |         // fall through to the honest count below
  167 |       }
  168 |       const count = await mentions.count()
  169 |       expect(
  170 |         count,
  171 |         "[A-5] the $500 design-partner offer is not stated on the first-run surface"
  172 |       ).toBeGreaterThan(0)
  173 |       const visible = []
  174 |       for (let index = 0; index < count; index++) {
  175 |         if (await mentions.nth(index).isVisible().catch(() => false)) visible.push(index)
  176 |       }
  177 |       expect(
  178 |         visible.length,
  179 |         `[A-5] $500 is stated ${visible.length} times — it must be stated exactly once`
  180 |       ).toBe(1)
  181 |     })
  182 | 
  183 |     test("[A-4] workspace pre-exists: no clone/install/configure copy anywhere", async ({ page }) => {
  184 |       await page.goto("/")
  185 |       await sendTurn(page, "What can you already see about my project?")
  186 |       const body = `${await smithersText(page)}\n${await transcript(page).innerText()}`
  187 |       const setupCopy = body.match(
  188 |         /[^.\n]*\b(clone (the|your)|git clone|npm install|pnpm install|bun install|configure (your|the)|set up your environment|install the)\b[^.\n]*/i
  189 |       )
  190 |       expect(
  191 |         setupCopy,
  192 |         `[A-4] setup copy detected — the workspace must pre-exist: "${setupCopy?.[0].slice(0, 160)}"`
  193 |       ).toBeNull()
  194 |     })
  195 | 
  196 |     test("[A-6] no card form anywhere product-wide", async ({ page }) => {
  197 |       await page.goto("/")
  198 |       await assertNoCardForm(page)
  199 |       await sendTurn(page, "What will this cost me?")
  200 |       await assertNoCardForm(page)
  201 |       // Billing-adjacent routes, if the app exposes them, must not collect a card either.
  202 |       for (const route of ["/billing", "/settings", "/settings/billing"]) {
  203 |         const response = await page.goto(route).catch(() => null)
  204 |         if (response !== null && response.ok()) await assertNoCardForm(page)
  205 |       }
  206 |     })
  207 | 
  208 |     test("[A-7] at most 3 questions in the whole first run", async ({ page }) => {
  209 |       await page.goto("/")
  210 |       await sendTurn(page, "Get me oriented.")
  211 |       await sendTurn(page, "What do you recommend I do first?")
  212 |       const messages = smithersMessages(page)
  213 |       let questions = 0
  214 |       const count = await messages.count()
  215 |       for (let index = 0; index < count; index++) {
  216 |         const text = await messages.nth(index).innerText()
  217 |         questions += (text.match(/\?/g) ?? []).length
  218 |       }
  219 |       expect(
  220 |         questions,
  221 |         `[A-7] Smithers asked ${questions} questions during the first run (> 3 budget)`
  222 |       ).toBeLessThanOrEqual(3)
  223 |     })
  224 | 
  225 |     test("[A-8] one recommendation card carries proposes / why-now / what-happens / accept-edit-dismiss", async ({ page }) => {
  226 |       await page.goto("/")
  227 |       await sendTurn(page, "What do you recommend I do first?")
  228 |       const cards = page.locator(sel.cards)
  229 |       const count = await cards.count()
  230 |       expect(
  231 |         count,
  232 |         "[A-8] missing feature: no recommendation card appeared during the first run"
  233 |       ).toBeGreaterThan(0)
  234 |       let found = false
  235 |       const failures: Array<string> = []
  236 |       for (let index = 0; index < count; index++) {
  237 |         const card = cards.nth(index)
  238 |         const text = await card.innerText()
  239 |         const hasProposes = /propos(e|es|al)/i.test(text)
  240 |         const hasWhyNow = /why[- ]now/i.test(text)
  241 |         const hasWhatHappens = /what happens/i.test(text)
  242 |         const actions = card.getByRole("button")
  243 |         const actionNames = (await actions.allInnerTexts()).join(" ").toLowerCase()
  244 |         const hasControls = /accept|approve|do it|go ahead/.test(actionNames) &&
  245 |           /edit/.test(actionNames) &&
  246 |           /dismiss|skip|not now/.test(actionNames)
  247 |         if (hasProposes && hasWhyNow && hasWhatHappens && hasControls) {
  248 |           found = true
  249 |           break
  250 |         }
  251 |         failures.push(
  252 |           `card ${index}: proposes=${hasProposes} whyNow=${hasWhyNow} whatHappens=${hasWhatHappens} acceptEditDismiss=${hasControls}`
  253 |         )
  254 |       }
  255 |       expect(
  256 |         found,
  257 |         `[A-8] no card carries proposes/why-now/what-happens with accept/edit/dismiss controls. ${failures.join(" | ")}`
> 258 |       ).toBe(true)
      |         ^ Error: [A-8] no card carries proposes/why-now/what-happens with accept/edit/dismiss controls. card 0: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false | card 1: proposes=false whyNow=false whatHappens=false acceptEditDismiss=false
  259 |     })
  260 | 
  261 |     test("[A-9] dismiss is one key and the same recommendation does not return unchanged", async ({ page }) => {
  262 |       await page.goto("/")
  263 |       await sendTurn(page, "What do you recommend I do first?")
  264 |       const cards = page.locator(sel.cards)
  265 |       expect(
  266 |         await cards.count(),
  267 |         "[A-9] missing feature: no recommendation card to dismiss"
  268 |       ).toBeGreaterThan(0)
  269 |       const before = (await cards.nth(0).innerText()).replace(/\s+/g, " ").trim()
  270 |       // The landed product's one-key dismiss is Escape (or d) WITH THE CARD
  271 |       // FOCUSED (`.reco-card` is tabbable for exactly this); a global Escape is
  272 |       // deliberately chat.stop, so pressing Escape with the composer focused
  273 |       // asserts a behavior the product never designed. Focus the card the way
  274 |       // a keyboard user reaches it, then one keypress must dismiss it.
  275 |       const recoCard = page.locator(".reco-card").first()
  276 |       await recoCard.focus()
  277 |       await page.keyboard.press("Escape")
  278 |       await expect(
  279 |         cards.nth(0),
  280 |         "[A-9] Escape did not dismiss the recommendation card in one keypress"
  281 |       ).toBeHidden({ timeout: 5_000 })
  282 |       // Keep working; the identical recommendation must not return unchanged.
  283 |       await sendTurn(page, "Ok — what else should I look at?")
  284 |       const after = page.locator(sel.cards)
  285 |       const afterCount = await after.count()
  286 |       for (let index = 0; index < afterCount; index++) {
  287 |         const text = (await after.nth(index).innerText()).replace(/\s+/g, " ").trim()
  288 |         expect(
  289 |           text === before,
  290 |           "[A-9] the dismissed recommendation returned unchanged after one-key dismiss"
  291 |         ).toBe(false)
  292 |       }
  293 |     })
  294 |   })
  295 | })
  296 | 
```