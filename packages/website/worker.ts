// The website on Workers: static assets, and /api/demo, the backend of the
// demos. It keeps the demo project's API key and token secret: browsers only
// ever get short tokens of the subject "demo", which edits the rooms opened
// here and nothing else.
import { createCloudClient, signCloudToken } from "pulsify-cloud";

export type DemoEnv = {
	/** The demo project, `https://api.pulsify.cloud/<project>`. */
	DEMO_PULSIFY_URL: string;
	DEMO_PULSIFY_API_KEY: string;
	DEMO_PULSIFY_TOKEN_SECRET: string;
	/** The only page origin that may open rooms and get tokens. */
	DEMO_ORIGIN: string;
	/** Rooms opened per minute and address; absent in development. */
	DEMO_RATE_LIMIT?: {
		limit(options: { key: string }): Promise<{ success: boolean }>;
	};
};

const SUBJECT = "demo";
/** Long enough for reloads, offline tests and phones that lose the network. */
export const ROOM_IDLE_MS = 10 * 60_000;
const ROOM = /^demo-[a-z2-7]{16}$/;
const newRoom = () =>
	`demo-${Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31],
	).join("")}`;

/**
 * `POST /api/demo` with `{ room? }`: without a room, opens a new one, a root
 * of its own on Pulsify Cloud that the subject "demo" may edit, erased after
 * ten minutes without anyone in it. Answers the
 * project URL, the room and a token valid two hours.
 */
export async function handleDemoRequest(
	request: Request,
	env: DemoEnv,
): Promise<Response> {
	const error = (message: string, status: number) =>
		Response.json({ error: message }, { status });
	if (request.method !== "POST") return error("Method not allowed", 405);
	if (
		!env.DEMO_PULSIFY_URL ||
		!env.DEMO_PULSIFY_API_KEY ||
		!env.DEMO_PULSIFY_TOKEN_SECRET
	)
		return error("The demos are not configured", 503);
	// Browsers send the page's origin and scripts cannot change it: another
	// site cannot get tokens through its visitors.
	if (request.headers.get("Origin") !== env.DEMO_ORIGIN)
		return error("Forbidden origin", 403);
	const { room: asked } = (await request.json().catch(() => ({}))) as {
		room?: unknown;
	};
	if (asked !== undefined && (typeof asked !== "string" || !ROOM.test(asked)))
		return error("Unknown room", 400);
	let room = asked;
	if (room === undefined) {
		const address = request.headers.get("CF-Connecting-IP") ?? "";
		if (
			env.DEMO_RATE_LIMIT &&
			!(await env.DEMO_RATE_LIMIT.limit({ key: address })).success
		)
			return error("Too many rooms, try again in a minute", 429);
		room = newRoom();
		try {
			const cloud = createCloudClient({
				url: env.DEMO_PULSIFY_URL,
				credential: env.DEMO_PULSIFY_API_KEY,
			});
			await cloud.grant({ subject: SUBJECT, prefix: room, role: "editor" });
			// The room and its Durable Object go once nobody used it for a while.
			await cloud.expire(room, { idleMs: ROOM_IDLE_MS });
		} catch (cause) {
			console.error(cause);
			return error("Pulsify Cloud did not open the room, try again", 502);
		}
	}
	// ponytail: anyone with the link edits the room, the token alone opens no room; per-visitor subjects if rooms need owners.
	const token = await signCloudToken(
		{ subject: SUBJECT },
		env.DEMO_PULSIFY_TOKEN_SECRET,
		{ expiresIn: "2h" },
	);
	return Response.json({ url: env.DEMO_PULSIFY_URL, room, token });
}

export default {
	fetch(
		request: Request,
		env: DemoEnv & { ASSETS: { fetch(request: Request): Promise<Response> } },
	): Promise<Response> {
		// Only /api/* runs the Worker first: every other path is a static asset.
		if (new URL(request.url).pathname === "/api/demo")
			return handleDemoRequest(request, env);
		return env.ASSETS.fetch(request);
	},
};
