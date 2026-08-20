# SWE-bench Verified scorecard

Instances: 5 · flows resolved **4/5** · codex resolved **4/5** · flows wins **0** · codex wins 0 · both pass 4 · both fail 1

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 837 | 1/1 |
| django__django-16612 | resolved | resolved | both pass | 643 | 5/7 |
| pydata__xarray-7393 | resolved | resolved | both pass | 658 | 1/1 |
| pytest-dev__pytest-6197 | resolved | resolved | both pass | 1,493 | 1/1 |
| sphinx-doc__sphinx-11445 | unresolved | unresolved | both fail | 832 | 6/8 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 127s | 101s | 11 | 11 | 9640 ms |
| django__django-16612 | 794s | 82s | 43 | 42 | 15544 ms |
| pydata__xarray-7393 | 121s | 81s | 11 | 11 | 8549 ms |
| pytest-dev__pytest-6197 | 198s | 183s | 6 | 6 | 30051 ms |
| sphinx-doc__sphinx-11445 | 823s | 82s | 52 | 52 | 14484 ms |

Totals: flows 2063s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 75,911 | 32,769 | 6,477 | $0.4264 | 37,867 | $0.1893 |
| django__django-16612 | 275,165 | 113,369 | 39,382 | $2.0471 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 83,378 | 30,274 | 5,501 | $0.4457 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 88,235 | 23,886 | 11,082 | $0.6661 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 415,424 | 177,389 | 44,207 | $2.6051 | 27,988 | $0.1399 |

Totals: flows $6.1904 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
