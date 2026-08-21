# SWE-bench Verified scorecard

Instances: 5 · flows resolved **4/5** · codex resolved **5/5** · flows wins **0** · codex wins 1 · both pass 4 · both fail 0

## Preconditions: the subject this wave measured

| | |
| --- | --- |
| subject | `sha256:5b35149e9c0343d89224c678f9167cc2d5b5ff9ee96fc6a5a17fd154e14143ab` |
| agreement | one subject, pinned and stamped by every instance |
| git HEAD | 8b9354e6e495f5487164db98c2c9f37551ea98a9 🔧 fix(evals): put the CLI's own source in the subject stamp, and cover the liveness reading offline |
| `packages/harness/src/CellTurn.ts` | `sha256:a834c2fd155f59545c6089b06265af56e9dea2f3d4254ec24adcb51aa0edb83d` |
| loaded from | packages/harness/src/CellTurn.ts |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` (11 modules) |
| `packages/cli/src` | `sha256:f6745ec4af0efc5f13a5ae3e9c6c21aa1f36fa469d45a59920f3adaa3e7a8e8f` (11 files, built above) |
| node | v24.18.0 darwin-arm64 |

Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src` directory, because that is where its workspace `exports` map points; the harness under test is the working tree, not a build. `packages/harness/dist` is not in the loaded graph and its state means nothing here.

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 1,042 | 0/2 |
| django__django-16612 | resolved | resolved | both pass | 643 | 1/1 |
| pydata__xarray-7393 | resolved | resolved | both pass | 625 | 1/1 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 551 | 1/1 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 415 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 469s | 101s | 15 | 15 | 28502 ms |
| django__django-16612 | 448s | 82s | 14 | 14 | 27935 ms |
| pydata__xarray-7393 | 126s | 81s | 10 | 10 | 9696 ms |
| pytest-dev__pytest-6197 | 1,203s | 183s | 25 | 24 | 47971 ms |
| sphinx-doc__sphinx-11445 | 165s | 82s | 5 | 5 | 29184 ms |

Totals: flows 2411s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 93,073 | 38,395 | 27,369 | $1.1137 | 37,867 | $0.1893 |
| django__django-16612 | 73,376 | 28,761 | 12,154 | $0.6021 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 86,755 | 21,579 | 5,742 | $0.5089 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 252,200 | 50,043 | 88,051 | $3.6773 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 35,366 | 10,287 | 8,329 | $0.3804 | 27,988 | $0.1399 |

Totals: flows $6.2824 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
