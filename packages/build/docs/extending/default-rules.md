# Default targets

A default target synthesizes targets for directories that have no `BUILD.ts` of
their own. It is how one declaration covers every conventional package in a
workspace.

```ts
// BUILD.ts
import { Smithers } from "@smthrs/targets"

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage
})
```

Every directory under `packages/` that contains a `package.json` and no
`BUILD.ts` now exports `lib`, `check`, `test`, `lint`, `fmt`, and `docs`.

## Options

| Option        | Type                      | Default          | Description                                                                                                            |
| ------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `directories` | `string \| Input.Glob`    | required         | Which directories the declaration covers. A string lifts to `glob(string)` and resolves against the declaring package. |
| `marker`      | `string \| null`          | `"package.json"` | A file that must exist in a directory for it to be eligible. Pass `null` to synthesize marker-less directories.        |
| `unless`      | `string`                  | `"BUILD.ts"`     | A file that, if present, makes the directory ineligible.                                                               |
| `macro`       | `(attrs) => object`       | required         | Called once per eligible directory.                                                                                    |
| `attrs`       | `Record<string, unknown>` | `{}`             | Passed to the macro, over a `cwd` default and the matched directory's manifest fields.                                 |

`PackageDefaults` validates and lifts the declaration while performing no I/O.

The declaration is a `BUILD.ts` export, so it is discovered the same way targets
are. It is not a target and gets no label. Declare workspace-wide defaults in the
root `BUILD.ts`; the workspace loads that file before it synthesizes anything.

## Eligibility

A directory is eligible for a declaration when all three hold:

1. The `marker` file exists directly inside it, unless the declaration's marker
   is `null`.
2. The `unless` file does not.
3. The directory matches the `directories` glob, and no `exclude` pattern of that
   glob.

Both the pattern and its excludes resolve against the package path of the
`BUILD.ts` that exported the declaration, so a declaration in the root uses
workspace-relative patterns. Matching uses `minimatch` with `dot: true`, against
the directory path itself, not its contents.

The workspace enumerates candidate directories from the discovered file list. A
declaration with a marker finds its candidates by the marker: every file equal
to or ending in `/<marker>` names one. A marker-less declaration has no file to
find candidates by, so its candidates are the directories that directly hold at
least one discovered file. A folder containing only further folders is never a
candidate, because a unit with no files of its own has nothing to build.
Directories are checked in sorted order, and the first eligible declaration
wins.

## Folder units

A marker-less declaration turns a folder inside a package into a buildable unit
without asking the folder for a `package.json`:

```ts
export const folderUnits = Smithers.PackageDefaults({
  directories: "packages/*/src/*",
  marker: null,
  macro: (attrs) => ({
    lib: Smithers.Typecheck({
      srcs: [Smithers.glob("*.ts")],
      deps: [],
      tsconfig: Smithers.file("//tsconfig.base.json"),
      buildMode: false,
      incremental: false,
      cwd: attrs.cwd
    })
  })
})
```

Now `//packages/engine/src/internal:lib` resolves even though the folder holds
no manifest and no `BUILD.ts`, and `//...` enumerates it. A marker-less unit is
not a package boundary: only a `BUILD.ts` creates one, so the parent's globs
still cover the folder's files and the parent's key still measures them. The
unit is an addressable subset of the parent, not a carve-out. To diverge from
the parent or to restrict visibility, write a `BUILD.ts` in the folder instead;
see [Workspace structure](../workspace/structure.md) for what the boundary
changes.

## Synthesis

For an eligible directory, the workspace calls:

```ts
macro({ cwd: directory, name, version, group, private, ...attrs })
```

`cwd` comes first, so a declared `attrs.cwd` overrides it. The four manifest
fields are read from the matched directory's `package.json` and are `undefined`
(or `false` for `private`) when the directory has no readable manifest, which is
every marker-less match. Every property of the returned object that passes
`Target.isTarget` becomes a synthesized target, named by its property key, with
names sorted so labels are deterministic. Non-target properties are ignored,
except `PackageJson` declarations, which expand into their check, write, and
refresh targets.

The labels are path-derived exactly like exported ones. A synthesized
`packages/greeter` produces `//packages/greeter:lib`, `//packages/greeter:test`,
and `//packages/greeter:lint`.

A macro that returns no targets fails with
`default target synthesized no targets for //<directory>`.

Synthesis is memoized per directory, and the same duplicate-label guard applies:
one target value registered under two labels fails the command.

### Manifests a synthesized unit may name

A synthesized `PackageJson` declaration resolves its `scripts` targets against
the whole index, not only the macro application that produced it: the macro's
own targets, and any target already registered because its package loaded
first. A target no package has registered yet fails synthesis with
`the default target for //<dir> declares a manifest naming a target with no label`,
because synthesis is synchronous and cannot load another package to find one.

The manifest itself still goes through `PackageJson`, which requires a
publishable npm name and a literal version. A resolution stub for a folder
unit, a `package.json` carrying `type` and `exports` and no publishable name,
is not expressible today. That shape is a cross-lane contract owed by the
manifest generator; until it lands, a unit manifest carries an explicit name
and version.

## Selection

Synthesized targets participate in patterns the same way exported ones do.

- `//packages/greeter:lib` resolves through synthesis when that directory has no
  `BUILD.ts`.
- `//packages/greeter` picks its default through the usual `lib`, `nodeModules`,
  basename, `default`, sole-export search.
- `//packages/...` includes every eligible directory in the subtree.

An exact label for a package that has neither a `BUILD.ts` nor a matching
declaration fails with
`package //<path> has no BUILD.ts and matches no default target`.

## Opting out

Write a `BUILD.ts`. The `unless` file defaults to `BUILD.ts`, so the directory
stops being eligible the moment it has one, and its explicit targets take over.
That is the intended upgrade path: start with a default target, and write a real
`BUILD.ts` for the packages that need something different.

## Limitation: no edges

Synthesis passes one static `attrs` value to every match, so every synthesized
package has no dependency edges, even when its `package.json` names workspace
siblings. The one exception is structural: a nested `BUILD.ts` that prunes a
synthesized parent's globs gains an automatic edge, because the boundary is a
fact of the file listing rather than of any declaration. See
[Workspace structure](../workspace/structure.md).

A synthesized package that needs edges gets a real `BUILD.ts`:

```ts
// packages/engine/BUILD.ts
import { Smithers } from "@smthrs/targets"
import { lib as flow } from "../flow/BUILD.ts"

export const { lib, check, test, lint, fmt, docs } = Smithers.StandardPackage({
  deps: [flow],
  cwd: "packages/engine"
})
```

## Several declarations

A workspace can export more than one declaration. The workspace orders them by
declaring package path and then export name, so every invocation sees one order
regardless of which `BUILD.ts` files a command happened to load, and the first
eligible one wins for a given directory. Scope them with disjoint globs or
distinct markers:

```ts
export const nodePackages = PackageDefaults({
  directories: glob("packages/*", { exclude: ["packages/web-*"] }),
  marker: "package.json",
  macro: StandardPackage
})

export const webPackages = PackageDefaults({
  directories: glob("packages/web-*"),
  marker: "package.json",
  macro: BrowserPackage
})
```

## What the property really is

The zero-boilerplate claim is scoped and measured. This repository carries 9
`BUILD.ts` files: the root, `lint`, `crates/flows-jj`, and six under
`packages/`. The other 39 of the 45 packages have none, so the honest statement
is **zero build files for 87% of packages**, and the property covers build-tool
configuration only: all 45 packages still hand-write six per-package tool
configs (`package.json`, `tsconfig.json`, `tsconfig.test.json`,
`vitest.config.ts`, `eslint.config.js`, `dprint.json`), 270 files in all.
`//:newPackage` scaffolds all of them; it writes no `BUILD.ts`.

One coverage gap is known and deliberate for now. `apps/server`, `apps/shared`,
`apps/tui`, `apps/ui`, `examples`, and `packages/build/infra` each carry a
`package.json` and are pnpm workspace members, but they match no
`PackageDefaults` glob (the root declaration covers `packages/*` only) and
hold no `BUILD.ts`. They have zero build-system targets, while the root
`pnpm test` still runs their suites. Closing the gap means extending
`directories` or adding declarations for those trees; nothing synthesizes for
them today.

## Next

- [Writing macros](writing-macros.md)
- [Workspace structure](../workspace/structure.md)
- [Labels](../concepts/labels.md)
