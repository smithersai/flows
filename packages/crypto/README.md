# @smthrs/crypto-next

Effect schemas for injected cryptographic operations.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Sha256 } from "@smthrs/crypto-next"
import { Effect, Schema } from "effect"

const digest = Effect.runSync(
  Schema.decodeUnknownEffect(Sha256)("hello")
    .pipe(Effect.provide(NodeCrypto.layer))
)

Schema.decodeUnknownSync(Sha256.Digest)(digest)
```
