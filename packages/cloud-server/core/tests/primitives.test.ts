import { describe, expect, test } from "bun:test";
import { encodeMessage } from "pulsify-core";
import {
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	cloudPath,
	covers,
	parseCloudPath,
	parseGrant,
	peekFrameHeader,
	readSubprotocols,
	roleFor,
	rootOf,
	signCloudToken,
	verifyCloudToken,
} from "pulsify-cloud";
import {
	authenticateCloudRequest,
	callerFromHeaders,
	callerToHeaders,
} from "pulsify-cloud-server";

const secret = "a test token secret of at least 32 characters";

describe("documents and roots", () => {
	test("a root is the ID before the first slash; prefixes stop at slashes", () => {
		expect(rootOf("u1")).toBe("u1");
		expect(rootOf("u1/notes/a")).toBe("u1");
		expect(covers("u1/notes", "u1/notes")).toBe(true);
		expect(covers("u1/notes", "u1/notes/a/b")).toBe(true);
		expect(covers("u1/notes", "u1/notes2")).toBe(false);
	});

	test("paths encode the root as one segment", () => {
		const path = cloudPath("équipe 1", "grants");
		expect(path).toBe("/v1/roots/%C3%A9quipe%201/grants");
		expect(parseCloudPath(path)).toEqual({
			root: "équipe 1",
			action: "grants",
		});
		expect(parseCloudPath("/v1/roots/a/delete")).toBeUndefined();
		expect(() => parseCloudPath("/v1/roots/a%2Fb/connect")).toThrow();
	});
});

describe("grants", () => {
	test("the strongest grant of the subject or of everyone wins", () => {
		const grants = [
			{ subject: "bob", prefix: "u1", role: "reader" },
			{ subject: "bob", prefix: "u1/notes/a", role: "editor" },
			{ subject: "*", prefix: "u1/public", role: "reader" },
			{ subject: "alice", prefix: "u1", role: "owner" },
		] as const;
		expect(roleFor(grants, "bob", "u1")).toBe("reader");
		expect(roleFor(grants, "bob", "u1/notes/a/b")).toBe("editor");
		expect(roleFor(grants, "carol", "u1/public/x")).toBe("reader");
		expect(roleFor(grants, "carol", "u1")).toBeUndefined();
		expect(roleFor(grants, "alice", "u1/notes/a")).toBe("owner");
	});

	test("grants are validated against their root", () => {
		expect(
			parseGrant("u1", { subject: "bob", prefix: "u1/a", role: "editor" }),
		).toEqual({
			subject: "bob",
			prefix: "u1/a",
			role: "editor",
		});
		for (const invalid of [
			{ subject: "bob", prefix: "u2/a", role: "editor" },
			{ subject: "bob", prefix: "u1/", role: "editor" },
			{ subject: "bob", prefix: "u1", role: "admin" },
			{ subject: "x".repeat(257), prefix: "u1", role: "reader" },
			[],
		])
			expect(() => parseGrant("u1", invalid)).toThrow();
	});
});

describe("authentication", () => {
	test("tokens carry an identity for the cloud audience only", async () => {
		const token = await signCloudToken({ subject: "u42" }, secret);
		expect(await verifyCloudToken(token, secret)).toEqual({ subject: "u42" });
		await expect(verifyCloudToken(token, `${secret}!`)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		const expired = await signCloudToken({ subject: "u42" }, secret, {
			expiresIn: -10,
		});
		await expect(verifyCloudToken(expired, secret)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(() => signCloudToken({ subject: "*" }, secret)).toThrow();
		expect(() => signCloudToken({ subject: "u42" }, "short")).toThrow();
	});

	test("requests authenticate by API key, bearer token, subprotocol or query", async () => {
		const secrets = {
			tokenSecret: secret,
			apiKey: "a test api key of at least thirty-two characters",
		};
		const token = await signCloudToken({ subject: "u42" }, secret);
		const url = "https://cloud.test/v1/roots/u42/connect";
		const user = { kind: "user", subject: "u42" } as const;
		expect(
			await authenticateCloudRequest(
				new Request(url, {
					headers: { Authorization: `Bearer ${secrets.apiKey}` },
				}),
				secrets,
			),
		).toEqual({ kind: "admin" });
		expect(
			await authenticateCloudRequest(
				new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
				secrets,
			),
		).toEqual(user);
		expect(
			await authenticateCloudRequest(
				new Request(url, {
					headers: {
						"Sec-WebSocket-Protocol": `${CLOUD_SUBPROTOCOLS[2]}, ${CLOUD_TOKEN_SUBPROTOCOL}${token}`,
					},
				}),
				secrets,
			),
		).toEqual(user);
		expect(
			await authenticateCloudRequest(
				new Request(`${url}?token=${token}`),
				secrets,
			),
		).toEqual(user);
		expect(
			await authenticateCloudRequest(new Request(url), secrets),
		).toBeUndefined();
		expect(callerFromHeaders(new Headers(callerToHeaders(user)))).toEqual(user);
	});
});

describe("session wire", () => {
	test("the envelope is negotiated with the token subprotocol", () => {
		expect(
			readSubprotocols(
				`${CLOUD_SUBPROTOCOLS[1]}, ${CLOUD_SUBPROTOCOLS[2]}, ${CLOUD_TOKEN_SUBPROTOCOL}abc`,
			),
		).toEqual({ envelope: 2, token: "abc" });
		expect(readSubprotocols(CLOUD_SUBPROTOCOLS[1])).toEqual({
			envelope: 1,
			token: undefined,
		});
		expect(readSubprotocols(null).envelope).toBeUndefined();
	});

	test("frames are routed by their header without decoding the body", () => {
		const frame = encodeMessage({
			kind: 1,
			docId: "u1/🌍",
			requestId: 300,
			vv: [[65536, 4]],
		});
		expect(peekFrameHeader(frame)).toEqual({
			envelope: 1,
			kind: 1,
			docId: "u1/🌍",
			requestId: 300,
		});
		expect(() => peekFrameHeader(frame.subarray(0, 5))).toThrow();
	});
});
