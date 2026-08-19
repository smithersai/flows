# Build-system rework, 2026-08-18

This directory records why the build system changed, not how to use it. Usage
documentation lives in `packages/build/docs`.

| File | What it is |
| --- | --- |
| [decisions.md](decisions.md) | The fifteen decisions D1-D15, as corrected. Each states what changed and why. |
| [corrections.md](corrections.md) | Sixteen premises the original decisions got wrong and fifteen items that could not be done as written, each verified by running the code rather than reading it. |
| [open-questions.md](open-questions.md) | Eight design questions raised by the agentic-task work, six ruled on here and two left to the maintainer. |

## Where the decisions came from

Three pull requests wired this repository with Nx (#226), Turborepo (#225), and
Bazel (#227), each measured against the in-repo system. The gaps those three
exposed became D1-D15.

## The one number that motivated the work

Before the rework, `smthrs ci "//..."` planned 278 targets and 232 of them —
83 percent — declared `cache: false` or fell through to a `false` default.
`DocsParity` was the only rule that cached across the workspace. Every compile,
typecheck, test, and lint re-executed on every run, warm or cold.

Flipping that default alone would have been worse than leaving it: the cache
stored a JSON success envelope with output digests and no bytes, so a hit on a
clean tree would have marked a build successful with no `dist/` on disk. The
content-addressed store landed first for that reason.
