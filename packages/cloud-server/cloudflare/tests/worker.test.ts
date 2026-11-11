import { expect, test } from "bun:test";
import {
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	signCloudToken,
} from "pulsify-cloud";
import { callerFromHeaders } from "pulsify-cloud-server";
import { handleCloudRequest, ROOT_HEADERS } from "../source/index.js";

const secrets = {
	PULSIFY_TOKEN_SECRET: "a test token secret of at least 32 characters",
	PULSIFY_API_KEY: "a test api key of at least thirty-two characters",
};

function namespace(seen: { name: string; request: Request }[], prefix = "") {
	return {
		idFromName: (name: string) => `${prefix}${name}`,
		get: (id: unknown) => ({
			async fetch(request: Request) {
				seen.push({ name: String(id), request });
				return new Response("forwarded");
			},
		}),
	};
}

test("the worker authenticates and forwards to the root's object without the credential", async () => {
	const seen: { name: string; request: Request }[] = [];
	const env = {
		...secrets,
		PULSIFY_ROOTS: {
			...namespace(seen),
			jurisdiction: () => namespace(seen, "eu:"),
		},
	};
	const token = await signCloudToken(
		{ subject: "u42" },
		secrets.PULSIFY_TOKEN_SECRET,
	);
	const upgrade = await handleCloudRequest(
		new Request("https://cloud.test/v1/roots/u%2042/connect?token=x", {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": `${CLOUD_SUBPROTOCOLS[2]}, ${CLOUD_TOKEN_SUBPROTOCOL}${token}`,
			},
		}),
		env,
	);
	expect(await upgrade.text()).toBe("forwarded");
	const forwarded = seen[0]!;
	expect(forwarded.name).toBe("u 42");
	expect(callerFromHeaders(forwarded.request.headers)).toEqual({
		kind: "user",
		subject: "u42",
	});
	expect(forwarded.request.headers.get(ROOT_HEADERS.action)).toBe("connect");
	expect(forwarded.request.headers.get(ROOT_HEADERS.envelope)).toBe("2");
	expect(forwarded.request.headers.get("Sec-WebSocket-Protocol")).toBeNull();
	expect(new URL(forwarded.request.url).search).toBe("");

	await handleCloudRequest(
		new Request("https://cloud.test/v1/roots/u42/grants", {
			headers: {
				Authorization: `Bearer ${secrets.PULSIFY_API_KEY}`,
				"x-pulsify-caller": "user:spoofed",
			},
		}),
		{ ...env, PULSIFY_JURISDICTION: "eu" },
	);
	expect(seen[1]!.name).toBe("eu:u42");
	expect(callerFromHeaders(seen[1]!.request.headers)).toEqual({
		kind: "admin",
	});
	expect(seen[1]!.request.headers.get("Authorization")).toBeNull();

	const denied = await handleCloudRequest(
		new Request("https://cloud.test/v1/roots/u42/connect", {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": CLOUD_SUBPROTOCOLS[1],
			},
		}),
		env,
	);
	expect(denied.status).toBe(401);
	const unconfigured = await handleCloudRequest(
		new Request("https://cloud.test/v1/health"),
		{ ...env, PULSIFY_API_KEY: "" },
	);
	expect(unconfigured.status).toBe(503);
	expect(seen).toHaveLength(2);
});
