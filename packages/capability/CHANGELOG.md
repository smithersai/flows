# @smthrs/capability-next

## 0.1.0

- Extracted `Capability` and `Permission` from `@smthrs/kernel-next` into a leaf
  package so a protected Host service (`@smthrs/jj-next`) can name the permission
  failures its guarded interface declares without depending on the kernel that
  guards it.
- Added `Permission.PermissionError`, `Permission.toPlatformError`, and
  `Permission.fromPlatformError` for the Effect-owned services whose tags fix
  their error channel to `PlatformError`.
