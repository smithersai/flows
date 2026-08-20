import { expect, test } from "bun:test";
import { sessionResponseForRequest } from "./Session.functions";

test("a Start session handoff avoids the fallback session subrequest", async () => {
	const envelope = encodeURIComponent(
		JSON.stringify({ status: 200, body: JSON.stringify({ status: "signed-out" }) }),
	);
	let fallbackCalls = 0;
	const response = await sessionResponseForRequest(
		new Request("https://mvp.test/", { headers: { "x-smithers-start-session": envelope } }),
		async () => {
			fallbackCalls += 1;
			return new Response(null, { status: 500 });
		},
	);

	expect(fallbackCalls).toBe(0);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: "signed-out" });
});

test("an invocation without the Start handoff keeps the fallback path", async () => {
	let fallbackCalls = 0;
	const response = await sessionResponseForRequest(new Request("https://mvp.test/"), async () => {
		fallbackCalls += 1;
		return new Response("fallback", { status: 201 });
	});

	expect(fallbackCalls).toBe(1);
	expect(response.status).toBe(201);
	expect(await response.text()).toBe("fallback");
});

test("a malformed handoff fails closed without making a fallback subrequest", async () => {
	let fallbackCalls = 0;
	await expect(
		sessionResponseForRequest(
			new Request("https://mvp.test/", { headers: { "x-smithers-start-session": "forged" } }),
			async () => {
				fallbackCalls += 1;
				return new Response(null, { status: 500 });
			},
		),
	).rejects.toBeInstanceOf(SyntaxError);
	expect(fallbackCalls).toBe(0);
});
