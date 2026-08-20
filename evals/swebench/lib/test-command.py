"""Prints the command that runs this instance's repository's tests.

    .venv-swb/bin/python lib/test-command.py <dataset.json> <instance_id>

The command comes from the pinned evaluator's own `MAP_REPO_VERSION_TO_SPECS`,
keyed by the instance's repo and version, so the agent is taught the same
runner the grader uses. Django has no pytest module, tox drives Sphinx, and
`python -m pytest` — what the rig used to prescribe for every repo — cannot run
either. The 2026-08-19 django run spent both of its verification attempts on
that dead command, never observed a passing check, and so never completed.

What is printed is environment teaching, not an answer: the repo's ordinary
test entry point, which any maintainer of that repo knows. The graded test
identifiers (`FAIL_TO_PASS`, `PASS_TO_PASS`) are never read here, and a spec
field that names them would be a leak — hence the assertion below.
"""

import json
import sys

from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS

LEAKY = ("FAIL_TO_PASS", "PASS_TO_PASS")


def main() -> int:
    dataset_path, instance_id = sys.argv[1], sys.argv[2]
    with open(dataset_path, encoding="utf-8") as handle:
        rows = json.load(handle)

    matches = [row for row in rows if row["instance_id"] == instance_id]
    if not matches:
        print(f"unknown instance {instance_id}", file=sys.stderr)
        return 1
    instance = matches[0]

    spec = MAP_REPO_VERSION_TO_SPECS.get(instance["repo"], {}).get(instance["version"], {})
    command = spec.get("test_cmd")
    if not command:
        print(
            f"no test_cmd for {instance['repo']} {instance['version']}",
            file=sys.stderr,
        )
        return 1

    if isinstance(command, list):
        command = " && ".join(command)
    for field in LEAKY:
        if field in command:
            print(f"refusing to print a command naming {field}", file=sys.stderr)
            return 1

    print(command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
