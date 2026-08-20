# model-relay-413 — the model relay's 413 names no way out

Origin: <https://canary.smithers.sh> (Worker `smithers-mvp-web`, version
`e84ad45e-0311-4eed-b326-dc0bc80aeec9`) · Account: `codeplanesmithers` ·
Tested: 2026-08-19, server lane round 3.

Related checklist row: **4.13** ("a very long turn still scrolls smoothly and
the composer stays responsive") — the wedge half of it, reported in
`../chat/4.13.md`.

## Steps

1. Sign in on <https://canary.smithers.sh>.
2. `POST /api/model/stream` with a `messages` array over the Worker's 1 MB body
   cap (the repro sends one 1.1 MB message).
3. `POST /api/agent/turn` with the same body, for contrast.

## Expected

Both model doors refuse the same way, and the refusal names what is too large
and what to do: the conversation has grown too long, start a new one.

## Actual

The two doors disagree. The turn seam is honest; the relay is not:

```
POST /api/model/stream -> 413 {"status":"error","message":"Request body is too large."}
POST /api/agent/turn   -> 413 {"status":"error","message":"This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."}
```

`Request body is too large.` is `BodyTooLargeError`'s own `Error.message`
rendered straight into the wire. It reads as a fact about the one request the
user just made, when it is a fact about the whole replayed transcript, and it
names no move. The relay is the door that matters: since the in-browser chain
became the only backend (`../admin/26.1.md`), every turn goes through
`/api/model/stream`, and `/api/agent/turn` is the one the user never reaches.

## Route and source

- Route: `POST /api/model/stream` on `smithers-mvp-web`.
- Source: `apps/server/src/index.ts`, `handleModelStream`'s `readTurnBody`
  catch — it mapped `BodyTooLargeError` to a bare 413 with
  `error.message`, while the turn handler had its own prose.

## Fix

`TRANSCRIPT_TOO_LARGE` in `apps/server/src/index.ts` is now one sentence used by
both doors. Regression test: "both model doors answer an over-cap transcript
with the same actionable 413" in `apps/server/src/index.test.ts`.

## Repro output (before the fix, against the deployed Worker)

```
$ bun canary-repros/server/model-relay-413.ts
session: {"login":"codeplanesmithers","allowlisted":true,"admin":true,"scopes":["read:user"]}
POST /api/model/stream -> 413 {"status":"error","message":"Request body is too large."}
POST /api/agent/turn  -> 413 {"status":"error","message":"This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."}
FAIL: the relay's 413 names no way out: {"status":"error","message":"Request body is too large."}
$ echo $?
1
```

The fix is committed but NOT deployed — this run does not deploy (the serial
deploy stage after it does). Re-run this repro after that deploy; it exits 0.

## Screenshot

None — both clauses are seam calls, and the output above is the evidence.
