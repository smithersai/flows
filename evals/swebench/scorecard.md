# SWE-bench Verified scorecard

Instances: 5 · flows resolved **3/5** · codex resolved **5/5** · flows wins **0** · codex wins 2 · both pass 3 · both fail 0

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 837 | 1/1 |
| django__django-16612 | resolved | resolved | both pass | 635 | 1/1 |
| pydata__xarray-7393 | resolved | resolved | both pass | 658 | 1/1 |
| pytest-dev__pytest-6197 | empty patch | resolved | codex win | 0 | 1/1 |
| sphinx-doc__sphinx-11445 | empty patch | resolved | codex win | 0 | 0/0 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 232s | 101s | 10 | 10 | 19671 ms |
| django__django-16612 | 507s | 82s | 25 | 25 | 19150 ms |
| pydata__xarray-7393 | 89s | 81s | 5 | 5 | 12695 ms |
| pytest-dev__pytest-6197 | 379s | 183s | 16 | 16 | 21726 ms |
| sphinx-doc__sphinx-11445 | 587s | 82s | 3 | 3 | 192922 ms |

Totals: flows 1794s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 102,477 | 32,280 | 13,519 | $0.7727 | 37,867 | $0.1893 |
| django__django-16612 | 148,550 | 61,453 | 29,505 | $1.3514 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 43,173 | 10,584 | 4,196 | $0.2941 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 121,986 | 27,026 | 20,219 | $1.0949 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 43,580 | 23,530 | 17,773 | $0.6452 | 27,988 | $0.1399 |

Totals: flows $4.1583 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
