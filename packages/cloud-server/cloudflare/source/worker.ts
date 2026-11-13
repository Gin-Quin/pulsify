import { CloudError } from "pulsify-cloud";
import {
	callerToHeaders,
	errorResponse,
	routeCloudRequest,
	type CloudCaller,
} from "pulsify-cloud-server";
import { ROOT_HEADERS } from "./PulsifyCloudRoot.js";

type DurableObjectNamespaceLike = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
	jurisdiction?(name: string): DurableObjectNamespaceLike;
};
export type PulsifyCloudEnv = {
	/** Durable Object binding of the `PulsifyCloudRoot` class. */
	PULSIFY_ROOTS: DurableObjectNamespaceLike;
	/** HS256 secret shared with the backend that signs user tokens. */
	PULSIFY_TOKEN_SECRET: string;
	/** Server-to-server key for the management API. */
	PULSIFY_API_KEY: string;
	/** Optional data residency, for example `"eu"`. */
	PULSIFY_JURISDICTION?: string;
	/**
	 * Milliseconds a root waits after its last socket closed before it compacts
	 * its history. Default 60000.
	 */
	PULSIFY_COMPACT_AFTER_MS?: string;
};

/**
 * The Worker in front of the roots: it authenticates, then forwards the
 * request to the Durable Object named after the root, near its first user.
 */
export async function handleCloudRequest(
	request: Request,
	env: PulsifyCloudEnv,
): Promise<Response> {
	if (!env.PULSIFY_TOKEN_SECRET || !env.PULSIFY_API_KEY || !env.PULSIFY_ROOTS)
		return errorResponse(
			new CloudError("UNAVAILABLE", "Pulsify Cloud is not configured"),
		);
	const route = await routeCloudRequest(request, {
		tokenSecret: env.PULSIFY_TOKEN_SECRET,
		apiKey: env.PULSIFY_API_KEY,
	});
	if (route.type === "response") return route.response;
	const namespace =
		env.PULSIFY_JURISDICTION && env.PULSIFY_ROOTS.jurisdiction
			? env.PULSIFY_ROOTS.jurisdiction(env.PULSIFY_JURISDICTION)
			: env.PULSIFY_ROOTS;
	const caller: CloudCaller =
		route.type === "connect"
			? { kind: "user", subject: route.subject }
			: route.caller;
	const headers = new Headers(request.headers);
	// The object trusts these headers; the credential itself goes no further.
	headers.delete("Authorization");
	headers.delete("Sec-WebSocket-Protocol");
	headers.set(ROOT_HEADERS.root, encodeURIComponent(route.root));
	headers.set(
		ROOT_HEADERS.action,
		route.type === "connect" ? "connect" : route.action,
	);
	headers.set(
		ROOT_HEADERS.envelope,
		route.type === "connect" ? String(route.envelope) : "1",
	);
	// The edge that accepted the socket, shown to clients for debugging.
	const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
	if (typeof colo === "string") headers.set(ROOT_HEADERS.location, colo);
	else headers.delete(ROOT_HEADERS.location);
	for (const [name, value] of Object.entries(callerToHeaders(caller)))
		headers.set(name, value);
	const url = new URL(request.url);
	url.searchParams.delete("token");
	return namespace
		.get(namespace.idFromName(route.root))
		.fetch(new Request(url, new Request(request, { headers })));
}

/** `export default cloudWorker` in your Worker entry. */
export const cloudWorker: {
	fetch(request: Request, env: PulsifyCloudEnv): Promise<Response>;
} = {
	fetch: (request: Request, env: PulsifyCloudEnv) =>
		handleCloudRequest(request, env),
};
