/**
 * Opt-in GitHub personas for hermetic e2e states a real account cannot be
 * returned to. Keep the whole cross-seam state in one literal: a suite picks
 * one persona and Stack.signInAs applies it to every double.
 */

export interface PersonaRepository {
	readonly fullName: string;
	readonly private: boolean;
	readonly pushedAt: string | null;
	readonly openIssues: number;
}

export interface PersonaGrant {
	readonly id: string;
	readonly kind: "promotional" | "purchased";
	readonly amountUsd: string;
}

export interface GithubPersona {
	readonly login: string;
	readonly history: "never" | "established";
	readonly repositories: ReadonlyArray<PersonaRepository>;
	readonly billing: {
		readonly balanceUsd: string;
		readonly chargeCount: number;
		readonly grants: ReadonlyArray<PersonaGrant>;
	};
	readonly reco: {
		/** null means the user has never chosen; [] means they deliberately chose none. */
		readonly watched: ReadonlyArray<string> | null;
		readonly dismissals: ReadonlyArray<string>;
	};
}

const repository = (login: string, name: string, index: number, isPrivate = false): PersonaRepository => ({
	fullName: `${login}/${name}`,
	private: isPrivate,
	pushedAt: new Date(Date.UTC(2026, 7, 18) - index * 86_400_000).toISOString(),
	openIssues: index % 7,
});

const fewRepositories = (login: string): ReadonlyArray<PersonaRepository> => [
	repository(login, "flows", 0),
	repository(login, "smithers", 1),
	repository(login, "mvp", 2, true),
];

const manyRepositories = (login: string): ReadonlyArray<PersonaRepository> =>
	Array.from({ length: 205 }, (_unused, index) =>
		repository(login, `repository-${String(index + 1).padStart(3, "0")}`, index, index % 5 === 0),
	);

const launchGrant: PersonaGrant = { id: "admin:launch-grant", kind: "promotional", amountUsd: "500" };

export const PERSONAS = {
	fresh: {
		login: "fresh-user",
		history: "never",
		repositories: fewRepositories("fresh-user"),
		billing: { balanceUsd: "500", chargeCount: 0, grants: [launchGrant] },
		reco: { watched: null, dismissals: [] },
	},
	zeroRepos: {
		login: "zero-repos-user",
		history: "never",
		repositories: [],
		billing: { balanceUsd: "500", chargeCount: 0, grants: [launchGrant] },
		reco: { watched: [], dismissals: [] },
	},
	manyRepos200: {
		login: "many-repos-user",
		history: "never",
		repositories: manyRepositories("many-repos-user"),
		billing: { balanceUsd: "500", chargeCount: 0, grants: [launchGrant] },
		reco: { watched: null, dismissals: [] },
	},
	zeroBalance: {
		login: "will",
		history: "established",
		repositories: fewRepositories("will"),
		billing: { balanceUsd: "0", chargeCount: 1, grants: [] },
		reco: { watched: ["will/flows"], dismissals: [] },
	},
	established: {
		login: "established-user",
		history: "established",
		repositories: fewRepositories("established-user"),
		billing: { balanceUsd: "499.94625", chargeCount: 1, grants: [launchGrant] },
		reco: {
			watched: ["established-user/flows", "established-user/smithers"],
			dismissals: [],
		},
	},
} as const satisfies Readonly<Record<string, GithubPersona>>;

export type PersonaName = keyof typeof PERSONAS;
