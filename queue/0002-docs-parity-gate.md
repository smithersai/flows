---
status: in-progress
anchor: head
priority: p0
---

# Docs parity gate as a tsflows rule

Implement the parity gate from `docs/specs/Concepts/Colocated Docs.md` as a
tsflows rule wired into `BUILD.ts`, so package documentation is a declared
build input and doc drift is a cache miss.

- A `DocsParity` rule per package: README.md present and non-trivial, every
  exported symbol carries JSDoc with `@since`/`@category` (the effect repo
  convention; `eslint.jsdoc.js` is the existing lint half).
- Declare each package's README as an input to its check targets via the
  Bazel-style `file()` declarations that landed in commit `04b9367`.
- Prior art to read first: the smithers DDD pack's `checkDocs.ts` and
  `docsManifest.ts` under `.smithers/lib/ddd/` in the outer repo.
- Resolve the open question in the Colocated Docs note (which export kinds
  require JSDoc; whether a change may declare "no doc impact") in the note,
  with how it was decided, before merging the rule.
