const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")
const Database = require("../../dist/cjs/Database.js")

assert.strictEqual(root.Database.Database, Database.Database)
assert.strictEqual(root.Database.DatabaseError, Database.DatabaseError)
