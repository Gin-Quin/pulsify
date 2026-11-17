import { afterEach, expect, test } from "bun:test";
import { verifyCloudToken } from "pulsify-cloud";
import { handleDemoRequest, ROOM_IDLE_MS, type DemoEnv } from "../worker";

const env: DemoEnv = {
	DEMO_PULSIFY_URL: "https://api.example/project",
	DEMO_PULSIFY_API_KEY: "pk_test",
	DEMO_PULSIFY_TOKEN_SECRET: "a-token-secret-of-at-least-32-characters",
	DEMO_ORIGIN: "https://pulsify.cloud",
};
const post = (body: unknown, origin = env.DEMO_ORIGIN) =>
	handleDemoRequest(
		new Request("https://pulsify.cloud/api/demo", {
			method: "POST",
			headers: { Origin: origin },
			body: JSON.stringify(body),
		}),
		env,
	);

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));
/** Records the management API calls and answers them. */
function cloud() {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return Response.json(JSON.parse(String(init?.body)));
	}) as typeof fetch;
	return calls;
}

test("a new room is a root that only the subject demo may edit, until it expires", async () => {
	const calls = cloud();
	const response = await post({});
	expect(response.status).toBe(200);
	const { url, room, token } = await response.json();
	expect(url).toBe(env.DEMO_PULSIFY_URL);
	expect(room).toMatch(/^demo-[a-z2-7]{16}$/);
	expect(calls).toHaveLength(2);
	expect(calls[0]!.url).toBe(`${env.DEMO_PULSIFY_URL}/v1/roots/${room}/grants`);
	expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe(
		"Bearer pk_test",
	);
	expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
		subject: "demo",
		prefix: room,
		role: "editor",
	});
	expect(calls[1]!.url).toBe(`${env.DEMO_PULSIFY_URL}/v1/roots/${room}/expire`);
	expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
		idleMs: ROOM_IDLE_MS,
	});
	expect(await verifyCloudToken(token, env.DEMO_PULSIFY_TOKEN_SECRET)).toEqual({
		subject: "demo",
	});
});

test("joining a room signs a token without granting anything", async () => {
	const calls = cloud();
	const response = await post({ room: "demo-abcdefghijklmnop" });
	expect(response.status).toBe(200);
	expect((await response.json()).room).toBe("demo-abcdefghijklmnop");
	expect(calls).toHaveLength(0);
});

test("other origins, rooms and methods are refused", async () => {
	const calls = cloud();
	expect((await post({}, "https://elsewhere.example")).status).toBe(403);
	expect((await post({ room: "example" })).status).toBe(400);
	expect((await post({ room: "demo-abcdefghijklmnop/x" })).status).toBe(400);
	expect(
		(
			await handleDemoRequest(
				new Request("https://pulsify.cloud/api/demo"),
				env,
			)
		).status,
	).toBe(405);
	expect(calls).toHaveLength(0);
});
