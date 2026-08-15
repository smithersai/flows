import { Effect, Layer, Redacted, Result } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as KernelHttpClient from "@smthrs/kernel/HttpClient";
import { Endpoint, Model, RequestExecutor, Route } from "@smthrs/model";
import { ModelAuthor } from "@smthrs/chain";
import type { Author } from "@smthrs/chain";
import { MODEL_STREAM_PATH } from "../../shared/AgentApiRoutes";
import type { FetchLike } from "../../shared/NativeAgent";

/*
 * The browser model seat (DESIGN.md §14, decision D1): the real @smthrs/model
 * Anthropic wire — protocol, SSE framing, ModelEvent fold — pointed at the
 * Worker's relay path instead of api.anthropic.com. The Worker session-gates
 * the call and injects the provider key; the placeholder key below therefore
 * never authenticates anything, it only satisfies the route's sealed-step
 * credential handling. ModelEvent decoding stays where effect lives.
 */

/** The concierge's default seat (overridable per turn). */
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export interface StreamModelOptions {
	/** Absolute origin of the product Worker; defaults to the page's own origin. */
	readonly baseUrl?: string;
	/** Injectable like every controller seam, so tests bind fixtures, not a network. */
	readonly fetchImpl?: FetchLike;
}

const relayOrigin = (baseUrl?: string): string => {
	if (baseUrl !== undefined && baseUrl !== "") return baseUrl;
	if (typeof location !== "undefined") return location.origin;
	return "http://localhost";
};

const relayRoute = (origin: string) => {
	const anthropic = Result.getOrThrow(
		Route.anthropic({ apiKey: Redacted.make("browser-relay-placeholder") }),
	);
	const endpoint = Result.getOrThrow(Endpoint.make({ url: origin, path: MODEL_STREAM_PATH }));
	return Route.make({ ...anthropic, id: "relay-anthropic", endpoint });
};

/** The Model service over the relay: Route ← RequestExecutor ← fetch HttpClient. */
export const layerModel = (options: StreamModelOptions = {}): Layer.Layer<Model.Model> => {
	const fetchLayer =
		options.fetchImpl === undefined
			? FetchHttpClient.layer
			: FetchHttpClient.layer.pipe(
					Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(options.fetchImpl as typeof fetch)),
				);
	const kernelHttp = Layer.effect(KernelHttpClient.HttpClient)(
		Effect.gen(function* () {
			return yield* HttpClient.HttpClient;
		}),
	).pipe(Layer.provide(fetchLayer));
	return Route.layer(relayRoute(relayOrigin(options.baseUrl))).pipe(
		Layer.provide(RequestExecutor.layer),
		Layer.provide(kernelHttp),
		Layer.provide(Layer.succeed(HttpClient.TracerDisabledWhen)(() => true)),
	) as Layer.Layer<Model.Model>;
};

export interface AuthorSeatOptions extends StreamModelOptions {
	readonly modelId?: string;
}

/** The chain's author seat over the relay model — what ChainRuntime provides. */
export const layerAuthor = (options: AuthorSeatOptions = {}): Layer.Layer<Author.Author> =>
	ModelAuthor.layer({ modelId: options.modelId ?? DEFAULT_MODEL_ID }).pipe(
		Layer.provide(layerModel(options)),
	) as Layer.Layer<Author.Author>;
