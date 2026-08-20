"""Runs the official SWE-bench evaluator against the architecture the rig uses.

    .venv-swb/bin/python lib/grade.py <the evaluator's own arguments>

The evaluator chooses its image architecture from `platform.machine()` alone
(`swebench/harness/test_spec/test_spec.py`: arm64 on an Apple Silicon host
unless the instance is in its `USE_X86` set). Every other part of this rig pins
`linux/amd64`: `run-instance.sh` and `run-instance-codex.sh` pull, extract, and
run `--platform linux/amd64`, so the agent edits an x86_64 checkout and its
patch is written against that tree. Left alone, grading on this host therefore
looks for `sweb.eval.arm64.<instance>`, finds none of the cached x86_64 images,
and tries to build one — which on 2026-08-19 timed out against the docker
socket and reported `django__django-16612` as an error rather than a verdict.

So this is not a thumb on the scale: it makes the grader use the same
architecture the patch was produced on. Nothing else is changed — the
evaluator's own code, dataset, and grading logic run untouched, and the tests
still execute inside the official image.

The override is process-local and lasts only for this invocation.
"""

import platform
import runpy
import sys

_REAL_MACHINE = platform.machine


def main() -> None:
    # Only the evaluator's image selection reads this; the containers it starts
    # report their own architecture from inside, unaffected.
    platform.machine = lambda: "x86_64"  # type: ignore[assignment]
    if _REAL_MACHINE() not in {"aarch64", "arm64"}:
        # On an x86_64 host the override is a no-op; say so rather than
        # implying a correction happened.
        print(f"grade.py: host is {_REAL_MACHINE()}; x86_64 selection is already native", file=sys.stderr)
    else:
        print(f"grade.py: host is {_REAL_MACHINE()}; selecting x86_64 images to match the rig's --platform linux/amd64", file=sys.stderr)

    sys.argv[0] = "swebench.harness.run_evaluation"
    runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")


if __name__ == "__main__":
    main()
