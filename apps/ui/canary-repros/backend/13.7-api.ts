/*
 * Backend-level repro of github/13.7 — "fake success writing to a read-only
 * repository", driven straight at api.jjhub.tech rather than through the SPA.
 *
 * `repo_context` resolves GitHub SOURCE coordinates ("octocat/Hello-World")
 * through the requester's own import provenance into a mirror living in the
 * requester's namespace. Reads may follow that alias. A WRITE resolved the same
 * way lands in the private mirror and answers 201 with a number the mirror
 * invented, so the product tells the user it opened an issue on a repository
 * they cannot write.
 *
 * Exits non-zero while the bug is present (the POST is accepted).
 * Exits 0 once the write is refused by name.
 *
 * Needs CANARY_API_TOKEN — a Smithers Cloud token for an account that has
 * imported octocat/Hello-World:
 *   export CANARY_API_TOKEN=$(kubectl get secret -n smithers -o json \
 *     | jq -r '.items[] | select(.data.CANARY_API_TOKEN) | .data.CANARY_API_TOKEN' \
 *     | head -1 | base64 -d)
 *   bun apps/ui/canary-repros/backend/13.7-api.ts
 */
const API = process.env.CANARY_API_BASE_URL ?? "https://api.jjhub.tech";
const TOKEN = process.env.CANARY_API_TOKEN ?? "";
if (TOKEN === "") {
	console.error("CANARY_API_TOKEN is required");
	process.exit(2);
}
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const readBack = await fetch(`${API}/api/repos/octocat/Hello-World`, { headers: auth });
const repo = (await readBack.json()) as { full_name?: string };
console.log(`GET /api/repos/octocat/Hello-World -> ${readBack.status} full_name=${repo.full_name ?? "<none>"}`);
if (readBack.status !== 200) {
	console.error("not-reachable: this account has no imported mirror of octocat/Hello-World");
	process.exit(2);
}

const stamp = new Date().toISOString();
const created = await fetch(`${API}/api/repos/octocat/Hello-World/issues`, {
	method: "POST",
	headers: auth,
	body: JSON.stringify({ title: `13.7 mirror-alias probe ${stamp}`, body: "written by the 13.7 repro" }),
});
const body = await created.text();
console.log(`POST /api/repos/octocat/Hello-World/issues -> ${created.status}`);
console.log(body.slice(0, 400));

if (created.status === 201) {
	const issue = JSON.parse(body) as { number: number };
	// Leave no open noise behind in the mirror.
	await fetch(`${API}/api/repos/${repo.full_name}/issues/${issue.number}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ state: "closed" }),
	});
	console.error(
		`FAIL: the platform accepted an issue on octocat/Hello-World and filed it as ${repo.full_name}#${issue.number}. ` +
			"github.com/octocat/Hello-World has no such issue.",
	);
	process.exit(1);
}

if (created.status === 409 && body.includes("never reach github.com")) {
	console.log("PASS — the write is refused by name, and both halves of the alias are stated.");
	process.exit(0);
}

console.error(`FAIL: unexpected answer ${created.status} — expected 409 naming the mirror.`);
process.exit(1);
