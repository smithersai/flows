import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"
import * as Database from "../../dist/esm/Database.js"

assert.strictEqual(root.Database.Database, Database.Database)
assert.strictEqual(root.Database.DatabaseError, Database.DatabaseError)
