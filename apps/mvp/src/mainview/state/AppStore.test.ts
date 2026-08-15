import { describe, expect, test } from "bun:test";
import type { StorageApi } from "@tanstack/db";
import { createAppStore } from "./AppStore";

/** Each test gets its own storage so cases never observe another case's writes. */
const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

describe("createAppStore with the localStorage fallback backend", () => {
	test("boots, seeds state, and reports the fallback persistence mode", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		expect(store.persistenceMode).toBe("localStorage");
		expect(store.session().id).toBe("main");
		// Wave 14 §1: the seed plants no opening message. An empty transcript is
		// the honest boot state — the first message is whatever the session
		// actually produces (the auth state signed out, the digest signed in).
		expect(store.collections.messages.size).toBe(0);
		expect(store.collections.worldDocuments.size).toBeGreaterThan(0);
	});

	test("dispatches transitions and journals them", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const before = store.session().revision;
		const transaction = store.dispatch({
			type: "composer.changed",
			actor: "user",
			draft: "hello from the fallback backend",
		});
		await transaction.isPersisted.promise;
		expect(store.session().draft).toBe("hello from the fallback backend");
		expect(store.session().revision).toBe(before + 1);
		const journal = [...store.collections.transitions.values()];
		expect(journal.some((record) => record.type === "composer.changed")).toBe(true);
	});


	test("persists state across store instances sharing one storage", async () => {
		const storage = memoryStorage();
		const first = await createAppStore({ kind: "localStorage", storage });
		const transaction = first.dispatch({
			type: "composer.changed",
			actor: "user",
			draft: "durable draft",
		});
		await transaction.isPersisted.promise;
		const second = await createAppStore({ kind: "localStorage", storage });
		expect(second.session().draft).toBe("durable draft");
	});

	test("boot reconciles an orphaned in-flight turn instead of restoring a stuck responding surface", async () => {
		const storage = memoryStorage();
		const first = await createAppStore({ kind: "localStorage", storage });
		// Simulate the app going away mid-turn: a submitted message, one delta,
		// and no done frame — the persisted phase stays "responding".
		await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-gone", text: "Do work" })
			.isPersisted.promise;
		await first.dispatch({
			type: "message.response.delta",
			actor: "smithers",
			turnId: "turn-gone",
			channel: "text",
			delta: "Working on it",
		}).isPersisted.promise;

		const second = await createAppStore({ kind: "localStorage", storage });
		expect(second.session().phase).toBe("idle");
		const restored = second.collections.messages.get("message-turn-gone-smithers");
		expect(restored?.status).toBe("interrupted");
		expect(restored?.statusDetail).toBe("That turn was interrupted when the app closed.");
		// The reconciliation is journaled like every other state change.
		const journal = [...second.collections.transitions.values()].map((entry) => entry.type);
		expect(journal).toContain("session.turn.orphaned");
	});

	/**
	 * The app can go away between the submit and the first delta — then the orphaned
	 * turn has no response message at all. Reconciliation must describe THAT turn and
	 * return the surface to idle WITHOUT relabelling an earlier, genuinely complete
	 * Smithers message: a transcript that says "interrupted" about a turn that
	 * finished is a lie.
	 */
	test("boot reconciliation describes a turn orphaned before its first delta, and relabels nothing else", async () => {
		const storage = memoryStorage();
		const first = await createAppStore({ kind: "localStorage", storage });
		// An earlier turn that genuinely FINISHED. Wave 14 §1 removed the seeded
		// welcome, so the "relabels nothing else" claim is now pinned against a
		// real completed response rather than a piece of seed data.
		await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-done", text: "Earlier work" })
			.isPersisted.promise;
		await first.dispatch({
			type: "message.response.delta",
			actor: "smithers",
			turnId: "turn-done",
			channel: "text",
			delta: "Finished that one",
		}).isPersisted.promise;
		await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "turn-done" })
			.isPersisted.promise;
		const finished = first.collections.messages.get("message-turn-done-smithers");
		expect(finished?.status).toBe("complete");
		// Submitted, then the app dies before a single delta arrives.
		await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-silent", text: "Do work" })
			.isPersisted.promise;

		const second = await createAppStore({ kind: "localStorage", storage });
		expect(second.session().phase).toBe("idle");
		// The earlier, genuinely complete turn is untouched...
		const restoredFinished = second.collections.messages.get("message-turn-done-smithers");
		expect(restoredFinished?.status).toBe("complete");
		expect(restoredFinished?.statusDetail).toBeUndefined();
		// ...and the orphaned turn is the one that carries the honest note.
		const orphaned = second.collections.messages.get("message-turn-silent-smithers");
		expect(orphaned?.status).toBe("interrupted");
		expect(orphaned?.text).toBe("That turn was interrupted when the app closed.");
	});
});
