# A.54 — `/prs.create` is a total no-op in every form

## Steps

1. `cp -R ~/.multi-e2e-profile /tmp/canary-flow-sweep-profile`
2. Open <https://canary.smithers.sh> signed in as `codeplanesmithers`.
3. Type each of these and press Enter:
   - `/prs.create flow-sweep repro title-only codeplanesmithers/canary-sandbox`
   - `/prs.create flow-sweep repro from:no-such-bookmark-zz codeplanesmithers/canary-sandbox`
   - `/prs.create flow-sweep repro from:main codeplanesmithers/no-such-repo-zz`
   - `/prs.create flow-sweep repro from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox`

## Expected

§14.3 — the pull request is opened and surfaces as the same `pr` card
`/prs.view` lands on; a bad form is refused with the seam's own honest line,
e.g. `prs.create needs a source branch — run /branches.list, then /prs.create
<title> from:<bookmark>`.

## Actual

All four render nothing. The seam does run — form 4 issues
`GET .../bookmarks?limit=100` and `GET .../changes?limit=100` — and then its
return value disappears. `POST .../landings` is never reached. The success path
was never observed on canary in any form.

## Root cause

`createLandingsSeam.createLanding`
(`apps/ui/src/mainview/state/seams/LandingsSeam.ts:341`) returns honest strings
for every refusal. `send()` in
`apps/ui/src/mainview/state/AppController.ts:2317` runs the flow as
`void commands.run(name, args)` and discards the `CommandOutcome`, so every one
of those strings is dropped. `/prs.create` always carries arguments, so it never
takes the button path that would toast the refusal — unlike the bare
`/prs.create`, which does toast `prs.create needs a title`.

## Selector / route

- Registry name `prs.create` in `[data-flows]`.
- Routes: `GET /api/repos/<owner>/<repo>/bookmarks?limit=100`,
  `GET /api/repos/<owner>/<repo>/changes?limit=100`, then (never reached)
  `POST /api/repos/<owner>/<repo>/landings`.

## Screenshot

`/tmp/canary-flow-sweep-shots/A.54.png`

## Repro

`apps/ui/canary-repros/flow-sweep/A.54.ts`

```
$ bun apps/ui/canary-repros/flow-sweep/A.54.ts
/prs.create flow-sweep repro title-only codeplanesmithers/canary-sandbox
  net: (none)
  added: []
/prs.create flow-sweep repro from:no-such-bookmark-zz codeplanesmithers/canary-sandbox
  net: 200 GET /api/repos/codeplanesmithers/canary-sandbox/bookmarks?limit=100
  added: []
/prs.create flow-sweep repro from:main codeplanesmithers/no-such-repo-zz
  net: 404 GET /api/repos/codeplanesmithers/no-such-repo-zz/bookmarks?limit=100
  added: []
/prs.create flow-sweep repro from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox
  net: 200 GET /api/repos/codeplanesmithers/canary-sandbox/bookmarks?limit=100 | 200 GET /api/repos/codeplanesmithers/canary-sandbox/changes?limit=100
  added: []
FAIL: /prs.create flow-sweep repro title-only codeplanesmithers/canary-sandbox rendered nothing at all
FAIL: /prs.create flow-sweep repro from:no-such-bookmark-zz codeplanesmithers/canary-sandbox rendered nothing at all
FAIL: /prs.create flow-sweep repro from:main codeplanesmithers/no-such-repo-zz rendered nothing at all
FAIL: /prs.create flow-sweep repro from:codeplanesmithers-patch-1 codeplanesmithers/canary-sandbox rendered nothing at all
exit=1
```
