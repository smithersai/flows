# SWE-bench Verified scorecard

Instances: 5 · flows resolved **3/5** · codex resolved **5/5** · flows wins **0** · codex wins 2 · both pass 3 · both fail 0

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 837 | 1/1 |
| django__django-16612 | empty patch | resolved | codex win | 0 | 0/0 |
| pydata__xarray-7393 | resolved | resolved | both pass | 658 | 4/5 |
| pytest-dev__pytest-6197 | unresolved | resolved | codex win | 619 | 1/2 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 414 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 1,203s | 101s | 6 | 6 | 24892 ms |
| django__django-16612 | 1,202s | 82s | 1 | 1 | 6768 ms |
| pydata__xarray-7393 | 964s | 81s | 19 | 19 | 18477 ms |
| pytest-dev__pytest-6197 | 1,203s | 183s | 16 | 16 | 16991 ms |
| sphinx-doc__sphinx-11445 | 1,203s | 82s | 5 | 5 | 10613 ms |

Totals: flows 5775s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 36,490 | 0 | 9,935 | $0.4805 | 37,867 | $0.1893 |
| django__django-16612 | 4,782 | 0 | 294 | $0.0327 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 182,802 | 58,736 | 22,181 | $1.3151 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 135,206 | 45,099 | 15,833 | $0.9481 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 38,984 | 10,265 | 3,322 | $0.2484 | 27,988 | $0.1399 |

Totals: flows $3.0248 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
