<!-- Deep reviewed and polished by a human. -->

# `@smthrs/canonical`

Wraps [`canonicalize`](https://www.npmjs.com/package/canonicalize) in Effect, following the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

```typescript
import { Canonical } from "@smthrs/canonical"
import { Schema } from "effect"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}'
```
