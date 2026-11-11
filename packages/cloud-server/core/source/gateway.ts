import {
	CLOUD_HEALTH_PATH,
	CloudError,
	parseCloudPath,
	readSubprotocols,
	type CloudEnvelope,
} from "pulsify-cloud";
import {
	authenticateCloudRequest,
	type CloudCaller,
	type CloudSecrets,
} from "./auth.js";
import { errorResponse, jsonResponse, preflightResponse } from "./http.js";

export type CloudRoute =
	| { type: "response"; response: Response }
	| { type: "connect"; root: string; subject: string; envelope: CloudEnvelope }
	| {
			type: "request";
			root: string;
			action: "grants" | "usage";
			caller: CloudCaller;
	  };

/**
 * The stateless front of every backend: route, authenticate and negotiate,
 * then hand the request to the root that owns it. Access rights are checked
 * by the root, which owns the grant table.
 */
export async function routeCloudRequest(
	request: Request,
	secrets: CloudSecrets,
): Promise<CloudRoute> {
	try {
		const url = new URL(request.url);
		if (request.method === "OPTIONS")
			return { type: "response", response: preflightResponse() };
		if (url.pathname === CLOUD_HEALTH_PATH)
			return { type: "response", response: jsonResponse({ ok: true }) };
		const path = parseCloudPath(url.pathname);
		if (!path) throw new CloudError("NOT_FOUND", "Unknown route");
		if (path.action === "connect") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
				throw new CloudError(
					"UPGRADE_REQUIRED",
					"Expected a WebSocket upgrade",
				);
			const { envelope } = readSubprotocols(
				request.headers.get("Sec-WebSocket-Protocol"),
			);
			if (!envelope)
				throw new CloudError(
					"BAD_REQUEST",
					"Offer a pulsify-cloud.1 subprotocol",
				);
			const caller = await authenticateCloudRequest(request, secrets);
			if (caller?.kind !== "user")
				throw new CloudError("UNAUTHORIZED", "A user token is required");
			return {
				type: "connect",
				root: path.root,
				subject: caller.subject,
				envelope,
			};
		}
		const caller = await authenticateCloudRequest(request, secrets);
		if (!caller) throw new CloudError("UNAUTHORIZED", "Missing credentials");
		return { type: "request", root: path.root, action: path.action, caller };
	} catch (error) {
		return { type: "response", response: errorResponse(error) };
	}
}
