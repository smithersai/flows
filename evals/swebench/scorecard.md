# SWE-bench Verified scorecard

Instances: 5 · flows resolved **3/5** · codex resolved **4/5** · flows wins **0** · codex wins 1 · both pass 3 · both fail 1

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 1,057 | 1/2 |
| django__django-16612 | resolved | resolved | both pass | 643 | 1/1 |
| pydata__xarray-7393 | resolved | resolved | both pass | 658 | 1/1 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 569 | 3/3 |
| sphinx-doc__sphinx-11445 | unresolved | unresolved | both fail | 442 | 0/0 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 494s | 101s | 20 | 20 | 13448 ms |
| django__django-16612 | 240s | 82s | 10 | 10 | 7668 ms |
| pydata__xarray-7393 | 420s | 81s | 13 | 13 | 8164 ms |
| pytest-dev__pytest-6197 | 1,134s | 183s | 30 | 29 | 8740 ms |
| sphinx-doc__sphinx-11445 | 276s | 82s | 5 | 4 | 13180 ms |

Totals: flows 2564s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 147,041 | 62,945 | 17,094 | $0.9648 | 37,867 | $0.1893 |
| django__django-16612 | 53,201 | 11,569 | 4,451 | $0.3475 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 95,655 | 22,121 | 5,988 | $0.5584 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 180,631 | 48,928 | 13,130 | $1.0769 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 23,908 | 4,162 | 2,621 | $0.1794 | 27,988 | $0.1399 |

Totals: flows $3.1270 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
