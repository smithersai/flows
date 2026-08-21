# SWE-bench Verified scorecard

Instances: 5 · flows resolved **4/5** · codex resolved **5/5** · flows wins **0** · codex wins 1 · both pass 4 · both fail 0

## Preconditions: the subject this wave measured

| | |
| --- | --- |
| subject | `sha256:801f12a56280a772dbf398a6de77e6ec031fb8d44e9e6e452ebeb1ced6661768` |
| agreement | one subject, pinned and stamped by every instance |
| git HEAD | fa78b9bd28f1533e5a468ee786864bc1429b3fd0 🐛 fix(agent,harness): bound the overrun re-issue, count a rejected cell, and let a host arm the repeat cap |
| `packages/harness/src/CellTurn.ts` | `sha256:2c9c7d0e825eba3932236b010c69b06575fe16d166047a65c655af316e554106` |
| loaded from | packages/harness/src/CellTurn.ts |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` (11 modules) |
| `packages/cli/src` | `sha256:f6745ec4af0efc5f13a5ae3e9c6c21aa1f36fa469d45a59920f3adaa3e7a8e8f` (11 files, built above) |
| node | v24.18.0 darwin-arm64 |

Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src` directory, because that is where its workspace `exports` map points; the harness under test is the working tree, not a build. `packages/harness/dist` is not in the loaded graph and its state means nothing here.

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 811 | 0/0 |
| django__django-16612 | resolved | resolved | both pass | 635 | 1/1 |
| pydata__xarray-7393 | resolved | resolved | both pass | 623 | 1/3 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 551 | 3/3 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 414 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 337s | 101s | 11 | 11 | 28388 ms |
| django__django-16612 | 89s | 82s | 5 | 5 | 13552 ms |
| pydata__xarray-7393 | 475s | 81s | 23 | 23 | 18268 ms |
| pytest-dev__pytest-6197 | 259s | 183s | 19 | 19 | 11854 ms |
| sphinx-doc__sphinx-11445 | 87s | 82s | 4 | 4 | 17381 ms |

Totals: flows 1247s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 74,165 | 9,648 | 15,525 | $0.7932 | 37,867 | $0.1893 |
| django__django-16612 | 27,988 | 4,812 | 4,560 | $0.2551 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 181,923 | 48,576 | 28,747 | $1.5534 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 176,594 | 43,678 | 11,081 | $1.0188 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 30,197 | 5,142 | 4,541 | $0.2641 | 27,988 | $0.1399 |

Totals: flows $3.8846 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
