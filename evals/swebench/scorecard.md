# SWE-bench Verified scorecard

Instances: 5 · flows resolved **3/5** · codex resolved **5/5** · flows wins **0** · codex wins 2 · both pass 3 · both fail 0

## Preconditions: the subject this wave measured

| | |
| --- | --- |
| subject | `sha256:b970dd40d1c65aff549c2357a36197500d55a29f0f04a48a1ff42c1304500d71` |
| agreement | one subject, pinned and stamped by every instance |
| git HEAD | 662716da9774c1e086f60f5d344bbfcbd5998127 🐛 fix(harness): give a bounced completion back rather than lose it to the budget |
| `packages/harness/src/CellTurn.ts` | `sha256:1409018179f19fffb17472e90eef2bc7067faf20632e81919a0b9d0b9e6f49fe` |
| loaded from | packages/harness/src/CellTurn.ts |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` (11 modules) |
| `packages/cli/src` | `sha256:f6745ec4af0efc5f13a5ae3e9c6c21aa1f36fa469d45a59920f3adaa3e7a8e8f` (11 files, built above) |
| node | v24.18.0 darwin-arm64 |

Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src` directory, because that is where its workspace `exports` map points; the harness under test is the working tree, not a build. `packages/harness/dist` is not in the loaded graph and its state means nothing here.

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 837 | 1/1 |
| django__django-16612 | empty patch | resolved | codex win | 0 | 0/0 |
| pydata__xarray-7393 | resolved | resolved | both pass | 623 | 1/5 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 551 | 1/2 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 414 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 126s | 101s | 7 | 7 | 14870 ms |
| django__django-16612 | 160s | 82s | 7 | 7 | 20023 ms |
| pydata__xarray-7393 | 559s | 81s | 18 | 18 | 28590 ms |
| pytest-dev__pytest-6197 | 323s | 183s | 14 | 14 | 20953 ms |
| sphinx-doc__sphinx-11445 | 141s | 82s | 5 | 5 | 23874 ms |

Totals: flows 1309s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 46,263 | 14,449 | 6,624 | $0.3650 | 37,867 | $0.1893 |
| django__django-16612 | 40,516 | 9,622 | 9,036 | $0.4304 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 130,017 | 57,056 | 31,473 | $1.3375 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 104,242 | 27,383 | 18,480 | $0.9524 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 40,292 | 0 | 7,447 | $0.4249 | 27,988 | $0.1399 |

Totals: flows $3.5102 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
