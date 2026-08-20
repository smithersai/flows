# TanStack DB Journal

Use SQLite-backed TanStack DB collections as the application authority. Every human, system, and Smithers mutation must pass an actor-recorded Flux transition dispatcher and an atomic Journal.transact boundary. Persist frame graph identity, workspace, branch, revision, and provenance; never let React own durable state.

