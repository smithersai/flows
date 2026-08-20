import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, getRequest, setCookie } from "@tanstack/react-start/server";
import type { BootSession } from "./BootSession";
import { unavailableBootSession } from "./BootSession";
/* The network law: every request this app makes is issued from state/seams/. */
import type { BootSessionRequest } from "./state/seams/BootSessionSeam";
import { bootSessionRequest } from "./state/seams/BootSessionSeam";

const AUTH_FAILED_COOKIE = "smithers_auth_failed";
const START_SESSION_HEADER = "x-smithers-start-session";

export const decodeStartSessionHandoff = (envelope: string): Response => {
	const parsed = JSON.parse(decodeURIComponent(envelope)) as { status?: unknown; body?: unknown };
	if (
		typeof parsed.status !== "number" ||
		!Number.isInteger(parsed.status) ||
		parsed.status < 200 ||
		parsed.status > 599 ||
		typeof parsed.body !== "string"
	) {
		throw new TypeError("Invalid Start session handoff.");
	}
	return new Response(parsed.body, { status: parsed.status });
};

const normalizeSession = async (response: Response, authFailed: boolean): Promise<BootSession> => {
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel();
		return { state: "signed-out", login: null, allowlisted: false, admin: false, authFailed };
	}
	if (!response.ok) {
		await response.body?.cancel();
		return unavailableBootSession(authFailed);
	}
	const body = (await response.json().catch(() => undefined)) as
		| { status?: unknown; login?: unknown; allowlisted?: unknown; admin?: unknown }
		| undefined;
	if (body?.status === "signed-out") {
		return { state: "signed-out", login: null, allowlisted: false, admin: false, authFailed };
	}
	if (body === undefined || typeof body.login !== "string" || body.login === "") {
		return unavailableBootSession(authFailed);
	}
	return {
		state: "signed-in",
		login: body.login,
		allowlisted: body.allowlisted === true,
		admin: body.admin === true,
		authFailed,
	};
};

export const sessionResponseForRequest = async (
	request: Request,
	fallback: BootSessionRequest = bootSessionRequest,
): Promise<Response> => {
	const envelope = request.headers.get(START_SESSION_HEADER);
	return envelope === null ? fallback(request) : decodeStartSessionHandoff(envelope);
};

const resolveCurrentRequest = async (): Promise<BootSession> => {
	const request = getRequest();
	const url = new URL(request.url);
	if (url.searchParams.get("auth") === "failed") {
		setCookie(AUTH_FAILED_COOKIE, "1", {
			httpOnly: true,
			sameSite: "lax",
			secure: url.protocol === "https:",
			path: "/",
			maxAge: 60,
		});
		url.searchParams.delete("auth");
		throw redirect({ href: `${url.pathname}${url.search}${url.hash}` });
	}

	const authFailed = getCookie(AUTH_FAILED_COOKIE) === "1";
	if (authFailed) deleteCookie(AUTH_FAILED_COOKIE, { path: "/" });
	try {
		const response = await sessionResponseForRequest(request);
		return normalizeSession(response, authFailed);
	} catch {
		return unavailableBootSession(authFailed);
	}
};

/** Resolve identity while rendering, and consume failed OAuth returns with a server redirect. */
export const resolveBootSession = createServerFn({ method: "GET" }).handler(
	async (): Promise<BootSession> => resolveCurrentRequest(),
);
