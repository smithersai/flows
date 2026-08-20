# flow-sweep lane — root causes behind the 30 failing rows

Verified live on <https://canary.smithers.sh> on 2026-08-19 as
`codeplanesmithers` (allowlisted; admin for the `reset`/`admin.*`/`debug.*`
rows). All 88 Appendix A flows were invoked by name on the target origin.

## 1. Typed `/<name> <args>` swallows every refusal (23 rows)

`send()` in `apps/ui/src/mainview/state/AppController.ts:2317` executes a
composer-submitted flow as

```ts
void commands.run(parsed.name, parsed.args);
```

and throws the `CommandOutcome` away. The button path in the same file
(`runCommand` / `runCommandArgs`, ~4363 / ~4369) attaches
`surfaceCommandFailure`, which raises `"/<name> didn't run"` over the seam's own
honest reason.

`apps/ui/src/mainview/App.tsx:625` sends Enter to `runSlashCommand` only while
the slash menu is open, and the menu matches a BARE name only. So the same flow,
with the same seam and the same refusal, behaves two different ways:

| typed | rendered |
| --- | --- |
| `/issues.view` | toast `/issues.view didn't run` + `issues.view needs an issue number` |
| `/issues.view 999999 codeplanesmithers/canary-sandbox` | nothing at all |

Success paths that dispatch their own card or transcript message are unaffected
(`/admin.allowlist.add <login>` answers fine). It is specifically the flow's
typed ERROR channel — `Effect.fail(string)` out of `Flows.ts`'s `act` — that is
dropped.

Hidden id-scoped flows (`approval.*`, `connector.*`, `world.select`,
`world.delete`, `card.*`, `flow.run.*`, `flow.repo.choose`, `toast.dismiss`,
`admin.grant.confirm|cancel`, `admin.queue.approve`) never appear in the slash
menu, so they take the `send()` path even when typed bare — they are silent on
every failure.

Rows: A.19, A.23, A.34 (bad id), A.38, A.46–A.53, A.55–A.57, A.60, A.64–A.67,
A.86, and A.54 in every form.

## 2. `{ value }`-only handlers render nothing for the human (4 rows)

`debug.snapshot`, `debug.events`, `debug.chain` and `debug.net`
(`AppController.ts:2516`, `:2543`, `:2556`, `:2564`) return only the `value`
payload the agent boundary hands to the model. Values never render in the
transcript (§2b), so a human typing them gets a silent no-op — even with the
dev-tools panel open. `debug.seams` is the counter-example: it renders the
`admin-health` card first and returns the value second.

Rows: A.74–A.77.

## 3. One-off defects

- **A.12** `/repos.watch.toggle no-such/repo` ADDS an unknown repository to the
  chooser selection instead of refusing it.
- **A.18** `/flow.create` sticks on "Preparing your … workspace…" forever and
  never calls `POST /api/workflow/provision`.
- **A.26** `/copy-message` lets the clipboard `NotAllowedError` escape as an
  unhandled rejection; the only trace is `POST /api/client-errors`.
- **A.34** `/world.delete` removes the note with no confirmation dialog (§10.6).
- **A.59 / A.60** the platform has no `/user/byok-keys` route —
  `GET` and `DELETE` both answer 404 from `api.jjhub.tech`, so BYOK has no
  success path on canary.
- **A.86** `/admin.queue.approve` leaves the entry in the request-access queue.

## Honesty note found while checking the model's catalog

The 30 user-only flows are correctly absent from the model's catalog (the
`commands` tool's `list` action returns 36 names, none of them user-only) and
`execute` refuses them by name. But when asked "Stop the current response", the
model answered **"Okay, I've stopped."** while the tool call had failed with
`/chat.stop is user-only`. The guard held; the model's sentence did not. Every
other user-only ask (theme, dark-mode, sign-out, clear, prs.land, reload,
billing.portal) was refused honestly.
