/*
 * The composer boundary: slash argument text in, a flow's typed payload out.
 *
 * Under the old `Command` interface every handler re-parsed its own `args?:
 * string` — the same trailing-`owner/repo` split written out dozens of times,
 * each free to drift. Flows take DECODED payloads, so the text-shaped step
 * happens exactly once: here, at the edge where a human's `/name <text>` (or
 * an agent's single argument string) becomes the record the flow's input
 * schema validates.
 *
 * A parse either produces the payload or an honest error naming what is
 * missing. The error never reaches the flow: an invocation that cannot be
 * parsed is refused before the handler runs, which is why no handler below the
 * boundary contains an argument check.
 */
import { splitTrailingRepo } from "../state/RepoContext";

/** A parsed invocation, or the honest refusal that names what is missing. */
export type Parsed =
	| { readonly payload: Record<string, unknown> }
	| { readonly error: string };

const ok = (payload: Record<string, unknown>): Parsed => ({ payload });
const no = (error: string): Parsed => ({ error });

/** The empty payload every no-argument flow takes. */
const NONE: Parsed = { payload: {} };

const trimmed = (args: string | undefined): string => (args ?? "").trim();

/** A required single-value payload, refused by name when the text is blank. */
const required = (field: string, args: string | undefined, reason: string): Parsed => {
	const value = trimmed(args);
	return value === "" ? no(reason) : ok({ [field]: value });
};

/** An optional single-value payload: blank text means the field is absent. */
const optional = (field: string, args: string | undefined): Parsed => {
	const value = trimmed(args);
	return ok(value === "" ? {} : { [field]: value });
};

/** A repo-scoped flow that takes nothing but its optional `owner/repo` target. */
const repoOnly = (name: string, args: string | undefined): Parsed => {
	const { rest, repo } = splitTrailingRepo(args);
	if (rest !== "") return no(`${name} takes just an owner/repo name`);
	return ok(repo === undefined ? {} : { repo });
};

/** A positive issue or pull-request number beside its optional repo. */
const numbered = (args: string | undefined, reason: string): Parsed => {
	const { rest, repo } = splitTrailingRepo(args);
	const number = Number(rest);
	if (!Number.isInteger(number) || number <= 0) return no(reason);
	return ok(repo === undefined ? { number } : { number, repo });
};

const tokensOf = (args: string | undefined): Array<string> =>
	trimmed(args)
		.split(/\s+/)
		.filter((token) => token !== "");

/*
 * The grammar, one entry per flow that accepts arguments. A flow absent from
 * this table takes the empty payload — which is also what a flow with no args
 * hint gets, since `parseSubmit` routes `/name <text>` for such a flow to the
 * agent as a prompt rather than to the flow.
 */
const GRAMMAR: Readonly<Record<string, (args: string | undefined) => Parsed>> = {
	theme: (args) => ok({ palette: args ?? "" }),
	send: (args) => required("text", args, "send needs the text to submit"),
	"repos.watch": (args) => optional("repo", args),
	"repos.watch.toggle": (args) =>
		required("fullName", args, "repos.watch.toggle needs a repository name"),
	browser: (args) =>
		required("url", args, "browser needs a URL: /browser https://example.com"),
	/*
	 * The description keeps the trailing `owner/repo` token: createWorkflow
	 * applies its OWN split, which (unlike splitTrailingRepo) leaves a lone
	 * repo-shaped word as the description. Splitting here would change which
	 * inputs name a target.
	 */
	"flow.create": (args) => ok({ description: trimmed(args) }),
	"flow.repo.choose": (args) =>
		required("repo", args, "flow.repo.choose needs a repository name"),
	"flow.run.stop": (args) => required("cardId", args, "flow.run.stop needs the card id"),
	"flow.run.retry": (args) => required("cardId", args, "flow.run.retry needs the card id"),
	"flow.run": (args) => {
		const [name, repo] = tokensOf(args);
		if (name === undefined) {
			return no("flow.run needs a workflow name: /flow.run create-workflow");
		}
		return ok(repo === undefined ? { name } : { name, repo });
	},
	"card.maximize": (args) => required("cardId", args, "card.maximize needs the card id"),
	// The clipboard text is taken verbatim: trimming would silently rewrite what
	// the human asked to copy.
	"copy-message": (args) =>
		(args ?? "") === "" ? no("copy-message needs the text to copy") : ok({ text: args ?? "" }),
	"approval.approve": (args) => required("cardId", args, "approval.approve needs the card id"),
	"approval.deny": (args) => required("cardId", args, "approval.deny needs the card id"),
	"connector.add": (args) => {
		const access = trimmed(args);
		if (access !== "read" && access !== "read-write") {
			return no("connector.add needs an access level: read or read-write");
		}
		return ok({ access });
	},
	"connector.downgrade": (args) =>
		required("connectorId", args, "connector.downgrade needs the connector id"),
	"connector.remove": (args) =>
		required("connectorId", args, "connector.remove needs the connector id"),
	"world.select": (args) => required("documentId", args, "world.select needs the document id"),
	"world.delete": (args) => required("documentId", args, "world.delete needs the document id"),
	"toast.dismiss": (args) => required("toastId", args, "toast.dismiss needs the toast id"),
	"reco.accept": (args) => optional("cardId", args),
	"reco.edit": (args) => optional("cardId", args),
	"reco.dismiss": (args) => optional("cardId", args),
	"repos.import": (args) => repoOnly("repos.import", args),
	"issues.list": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		const filter = rest === "" ? "open" : rest;
		if (filter !== "open" && filter !== "closed" && filter !== "all") {
			return no("issues.list takes open, closed, or all");
		}
		return ok(repo === undefined ? { filter } : { filter, repo });
	},
	"issues.view": (args) => numbered(args, "issues.view needs an issue number"),
	"issues.create": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		if (rest === "") return no("issues.create needs a title");
		return ok(repo === undefined ? { title: rest } : { title: rest, repo });
	},
	"issues.close": (args) => numbered(args, "issues.close needs an issue number"),
	"issues.reopen": (args) => numbered(args, "issues.reopen needs an issue number"),
	"issues.comment": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		const [head, ...tail] = rest.split(/\s+/);
		const number = Number(head);
		const text = tail.join(" ").trim();
		if (!Number.isInteger(number) || number <= 0) return no("issues.comment needs an issue number");
		if (text === "") return no("issues.comment needs the comment text");
		return ok(repo === undefined ? { number, text } : { number, text, repo });
	},
	"prs.list": (args) => repoOnly("prs.list", args),
	"prs.view": (args) => numbered(args, "prs.view needs a pull request number"),
	"prs.create": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		// The source bookmark rides as a `from:<name>` token anywhere in the text;
		// /branches.list shows the choices.
		const tokens = rest.split(/\s+/).filter((token) => token !== "");
		const fromToken = tokens.find((token) => token.startsWith("from:"));
		const from = fromToken?.slice("from:".length);
		const title = tokens.filter((token) => !token.startsWith("from:")).join(" ");
		if (title === "") return no("prs.create needs a title");
		if (fromToken !== undefined && (from === undefined || from === "")) {
			return no("prs.create's from: token needs a bookmark name — see /branches.list");
		}
		return ok({
			title,
			...(from === undefined || from === "" ? {} : { from }),
			...(repo === undefined ? {} : { repo }),
		});
	},
	"prs.land": (args) => numbered(args, "prs.land needs a pull request number"),
	"prs.review": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		const [head, verdict, ...tail] = rest.split(/\s+/);
		const number = Number(head);
		if (!Number.isInteger(number) || number <= 0) return no("prs.review needs a pull request number");
		const type =
			verdict === "approve"
				? "approve"
				: verdict === "request-changes"
					? "request_changes"
					: verdict === "comment"
						? "comment"
						: undefined;
		if (type === undefined) {
			return no("prs.review needs a verdict: approve, request-changes, or comment");
		}
		const text = tail.join(" ").trim();
		return ok(repo === undefined ? { number, verdict: type, text } : { number, verdict: type, text, repo });
	},
	"billing.upgrade": (args) => optional("plan", args),
	"keys.remove": (args) => required("provider", args, "keys.remove needs the provider name"),
	"env.view": (args) => repoOnly("env.view", args),
	"env.set": (args) => {
		const { rest, repo } = splitTrailingRepo(args);
		if (rest === "") return no("env.set needs a NAME=value pair");
		return ok(repo === undefined ? { assignment: rest } : { assignment: rest, repo });
	},
	"branches.list": (args) => repoOnly("branches.list", args),
	"files.list": (args) => {
		const tokens = tokensOf(args);
		if (tokens.length > 2) return no("files.list takes a path and optionally an owner/repo");
		const [path, repo] = tokens;
		return ok(repo === undefined ? { path: path ?? "" } : { path: path ?? "", repo });
	},
	"files.read": (args) => {
		const tokens = tokensOf(args);
		const [path, repo] = tokens;
		if (path === undefined || path === "") return no("files.read needs a file path");
		if (tokens.length > 2) return no("files.read takes a path and optionally an owner/repo");
		return ok(repo === undefined ? { path } : { path, repo });
	},
	"repos.app": (args) => repoOnly("repos.app", args),
	"debug.backend": (args) => ok({ backend: args ?? "" }),
	"admin.allowlist.add": (args) => required("login", args, "admin.allowlist.add needs a login"),
	"admin.allowlist.remove": (args) =>
		required("login", args, "admin.allowlist.remove needs a login"),
	"admin.grant": (args) => {
		const [amountRaw, login] = tokensOf(args);
		const amountUsd = Number(amountRaw);
		if (
			amountRaw === undefined ||
			!Number.isFinite(amountUsd) ||
			amountUsd <= 0 ||
			login === undefined ||
			login === ""
		) {
			return no("admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat");
		}
		return ok({ amountUsd, login });
	},
	"admin.grant.confirm": (args) =>
		required("cardId", args, "admin.grant.confirm needs the card id"),
	"admin.grant.cancel": (args) => required("cardId", args, "admin.grant.cancel needs the card id"),
	"admin.queue.approve": (args) => required("login", args, "admin.queue.approve needs a login"),
};

/**
 * Turns one flow's slash argument text into its typed payload.
 *
 * @category conversions
 */
export const payloadFor = (name: string, args: string | undefined): Parsed => {
	const parse = GRAMMAR[name];
	return parse === undefined ? NONE : parse(args);
};
