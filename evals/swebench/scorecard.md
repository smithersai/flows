# SWE-bench Verified scorecard

Instances: 5 · flows resolved **4/5** · codex resolved **5/5** · flows wins **0** · codex wins 1 · both pass 4 · both fail 0

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 1,501 | 1/1 |
| django__django-16612 | resolved | resolved | both pass | 635 | 1/1 |
| pydata__xarray-7393 | resolved | resolved | both pass | 678 | 2/2 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 25,080 | 3/3 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 439 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 141s | 101s | 7 | 7 | 14047 ms |
| django__django-16612 | 211s | 82s | 8 | 8 | 17657 ms |
| pydata__xarray-7393 | 350s | 81s | 12 | 12 | 25557 ms |
| pytest-dev__pytest-6197 | 500s | 183s | 27 | 26 | 16738 ms |
| sphinx-doc__sphinx-11445 | 245s | 82s | 6 | 6 | 33657 ms |

Totals: flows 1447s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 48,697 | 12,793 | 6,261 | $0.3737 | 37,867 | $0.1893 |
| django__django-16612 | 54,288 | 25,288 | 8,185 | $0.4032 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 108,105 | 26,503 | 20,695 | $1.0421 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 219,978 | 58,726 | 25,131 | $1.5896 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 42,574 | 15,497 | 12,873 | $0.5293 | 27,988 | $0.1399 |

Totals: flows $3.9379 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
