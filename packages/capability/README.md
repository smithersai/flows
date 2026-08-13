# @smthrs/capability-next

Capability values and permission failures — the leaf vocabulary of the `flows`
permission kernel.

This package holds **only** the words, never the enforcement. `@smthrs/kernel-next`
owns the `GrantStore`, the decorating layers, and the journal; this package owns
the `Capability` value, its wildcard `CapabilityPattern`, the effect tiers, and
the three typed failures a guarded Host call can add:

| Module       | Contents                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Capability` | `Capability`, `CapabilityPattern`, `Action`, `matches`, `subsumes`, `tierOf`, `EffectTier`.                                                      |
| `Permission` | `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, the `PermissionError` union, `Rule`/`evaluate`, `PlatformError` projection helpers. |

## Why it is its own package

A protected Host service declares permission failures in **its own** interface —
`@smthrs/jj-next`'s `Jj` fails with `JjError | PermissionError`, not with a widened
copy of itself minted by the kernel. That would make `@smthrs/jj-next` depend on
`@smthrs/kernel-next`, which already depends on `@smthrs/jj-next`. Both depend on this
leaf instead, and it depends on nothing but `effect`, so the browser bundle is
unaffected.

Schema ids (`@smthrs/capability-next/Capability`, `@smthrs/capability-next/PermissionDenied`, …)
are digested into step keys and round-trip through the grant journal, so
renaming one invalidates recorded runs.
