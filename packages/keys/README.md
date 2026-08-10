# @smthrs/keys

An Effect schema for canonical workflow keys.

```sh
npm install @smthrs/keys
```

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Key } from "@smthrs/keys"
import { Effect, Schema } from "effect"

const key = Effect.runSync(
  Schema.decodeUnknownEffect(Key)({ operation: "compile", version: 1 })
    .pipe(Effect.provide(NodeCrypto.layer))
)
// "key1_<64 lowercase hex>"
```

See the [keys reference](../../docs/reference/keys.md).
