# SWE-bench Verified scorecard

Instances: 5 · flows resolved **2/5** · codex resolved **5/5** · flows wins **0** · codex wins 3 · both pass 2 · both fail 0

## Preconditions: the subject this wave measured

| | |
| --- | --- |
| subject | `sha256:0de53282be158dbeccd2ea8d71b402a79d58dd089955e35c14f2c0e9f743f835` |
| agreement | one subject, pinned and stamped by every instance |
| git HEAD | ad84c8bd213ef0a171463418cd776938953ea0ed 🐛 fix(harness): stop a completion demand taking back the frame it reserved |
| `packages/harness/src/CellTurn.ts` | `sha256:36e20148832e648ba8b59fd3b6bee79847e436ef5ad008bd89561a22f002c52e` |
| loaded from | packages/harness/src/CellTurn.ts |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` (11 modules) |
| `packages/cli/src` | `sha256:f6745ec4af0efc5f13a5ae3e9c6c21aa1f36fa469d45a59920f3adaa3e7a8e8f` (11 files, built above) |
| node | v24.18.0 darwin-arm64 |

Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src` directory, because that is where its workspace `exports` map points; the harness under test is the working tree, not a build. `packages/harness/dist` is not in the loaded graph and its state means nothing here.

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 875 | 1/7 |
| django__django-16612 | empty patch | resolved | codex win | 0 | 0/0 |
| pydata__xarray-7393 | empty patch | resolved | codex win | 0 | 0/1 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 674 | 1/1 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 415 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 1,188s | 101s | 42 | 42 | 26052 ms |
| django__django-16612 | 103s | 82s | 2 | 2 | 43126 ms |
| pydata__xarray-7393 | 401s | 81s | 24 | 24 | 14844 ms |
| pytest-dev__pytest-6197 | 157s | 183s | 12 | 12 | 10065 ms |
| sphinx-doc__sphinx-11445 | 167s | 82s | 11 | 11 | 12811 ms |

Totals: flows 2016s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 258,105 | 57,576 | 72,737 | $3.2135 | 37,867 | $0.1893 |
| django__django-16612 | 13,665 | 9,558 | 6,441 | $0.2185 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 172,524 | 53,741 | 21,734 | $1.2728 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 99,974 | 38,109 | 7,287 | $0.5470 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 83,045 | 25,650 | 6,668 | $0.4998 | 27,988 | $0.1399 |

Totals: flows $5.7516 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
