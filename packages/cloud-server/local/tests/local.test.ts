import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	loadPulse,
	object,
} from "pulsify-core";
import {
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	cloudPath,
	createCloudClient,
	createCloudConnector,
	signCloudToken,
} from "pulsify-cloud";
import { eventually } from "../../core/tests/conformance.js";
import { rootFileName, startLocalCloud } from "../source/index.js";

const secrets = {
	tokenSecret: "a test token secret of at least 32 characters",
	apiKey: "a test api key of at least thirty-two characters",
};
const Note = definePulse(
	"LocalNote",
	object({ title: "string" }),
).materialize();

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "pulsify-local-"));
	cleanups.push(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function start(path: string, compactAfterMs = 60_000) {
	const server = startLocalCloud({
		directory: path,
		port: 0,
		secrets,
		compactAfterMs,
	});
	cleanups.push(() => server.stop());
	return server;
}
const admin = (url: string) =>
	createCloudClient({ url, credential: secrets.apiKey });
const sign = (subject: string) =>
	signCloudToken({ subject }, secrets.tokenSecret, { expiresIn: "10m" });
function device(url: string, subject: string) {
	const connector = createCloudConnector({
		url,
		token: () => sign(subject),
		lingerMs: 0,
	});
	cleanups.push(() => connector.close());
	return {
		connector,
		options: {
			connectors: [connector],
			scope: createPulseScope(),
			timeoutMs: 5_000,
		},
	};
}

test("a root's file name is readable, and safe whatever the root", () => {
	expect(rootFileName("room-42_a")).toBe("room-42_a");
	expect(rootFileName("..")).toBe("%2e%2e");
	expect(rootFileName("ada@example.com")).toBe("ada%40example%2ecom");
	expect(rootFileName("é%")).toBe("%c3%a9%25");
	// A disk that ignores case must not give `Room` the file of `room`.
	expect(rootFileName("Room")).toBe("%52oom");
	const long = rootFileName("r".repeat(1024));
	expect(long).toMatch(/^~[0-9a-f]{64}$/);
	expect(rootFileName("R".repeat(1024))).not.toBe(long);
});

test("each root is one SQLite file of its project, read again after a restart", async () => {
	const path = directory();
	const first = start(path);
	const url = `${first.url}/dev`;
	expect(await (await fetch(`${first.url}/health`)).json()).toEqual({
		ok: true,
	});
	expect((await fetch(`${url}/v1/health`)).status).toBe(200);
	// The hosted service answers the same for a project it does not know.
	const unknown = await fetch(`${first.url}/Not_A_Project/v1/health`);
	expect(unknown.status).toBe(404);
	expect(await unknown.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

	await admin(url).grant({ subject: "alice", prefix: "Room.1", role: "owner" });
	const a = device(url, "alice");
	const note = createPulse(Note, { id: "Room.1", title: "Kept" }, a.options);
	await connectPulse(note).synced;
	// Same root, other project: other file, other grants.
	expect(await admin(`${first.url}/other`).grants("Room.1")).toEqual([]);
	a.connector.close();
	first.stop();
	// Closed, a root leaves nothing but its file.
	expect(readdirSync(path).sort()).toEqual(["dev", "other"]);
	expect(readdirSync(join(path, "dev"))).toEqual(["%52oom%2e1.sqlite"]);
	expect(readdirSync(join(path, "other"))).toEqual(["%52oom%2e1.sqlite"]);

	const second = start(path);
	const b = device(`${second.url}/dev`, "alice");
	const loaded = await loadPulse(Note, "Room.1", b.options);
	expect(loaded.title).toBe("Kept");
	expect(await admin(`${second.url}/dev`).usage("Room.1")).toMatchObject({
		documents: 1,
		connections: 1,
	});
});

test("an idle root that expires or is empty deletes its file; a deleted root keeps its tombstone", async () => {
	const path = directory();
	const { url: origin } = start(path, 100);
	const url = `${origin}/dev`;
	const file = (root: string) => join(path, "dev", `${root}.sqlite`);
	const connect = async (root: string) => {
		const socket = new WebSocket(
			`${url.replace(/^http/, "ws")}${cloudPath(root, "connect")}`,
			[CLOUD_SUBPROTOCOLS[2], CLOUD_TOKEN_SUBPROTOCOL + (await sign("alice"))],
		);
		cleanups.push(() => socket.close());
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve);
			socket.addEventListener("error", reject);
		});
		return socket;
	};

	// Nothing to lose in a root that holds no document, grant or tombstone.
	const visitor = await connect("empty");
	expect(existsSync(file("empty"))).toBe(true);
	visitor.close();
	await eventually(() => expect(existsSync(file("empty"))).toBe(false));

	// A root with a grant stays, until it is told to expire.
	await admin(url).grant({ subject: "alice", prefix: "room", role: "owner" });
	const a = device(url, "alice");
	const note = createPulse(Note, { id: "room", title: "Gone soon" }, a.options);
	await connectPulse(note).synced;
	expect(await admin(url).expire("room", { idleMs: 60_000 })).toEqual({
		idleMs: 60_000,
	});
	// A minute is the shortest lifetime: shorten it behind the server's back.
	const database = new Database(file("room"));
	database.run("UPDATE pulsify_cloud_expiry SET idle_ms = 100");
	database.close();
	a.connector.close();
	await eventually(() => expect(existsSync(file("room"))).toBe(false));
	expect(await admin(url).grants("room")).toEqual([]);

	// Deleting a root closes its sockets and retires its ID for good.
	await admin(url).grant({ subject: "alice", prefix: "old", role: "owner" });
	const socket = await connect("old");
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener("close", resolve),
	);
	await admin(url).deleteDocument("old");
	expect((await closed).reason).toBe("Root deleted");
	await Bun.sleep(300);
	expect(existsSync(file("old"))).toBe(true);
	const again = await fetch(`${url}${cloudPath("old", "grants")}`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${secrets.apiKey}` },
		body: JSON.stringify({ subject: "alice", prefix: "old", role: "owner" }),
	});
	expect(again.status).toBe(404);
});

test("`pulsify dev` serves a project and prints what an app needs to reach it", async () => {
	const path = directory();
	const child = Bun.spawn(
		[
			"bun",
			new URL("../source/cli.ts", import.meta.url).pathname,
			"dev",
			"--port",
			"0",
			"--dir",
			path,
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	cleanups.push(() => child.kill());
	let output = "";
	const decoder = new TextDecoder();
	for await (const chunk of child.stdout) {
		output += decoder.decode(chunk);
		if (output.includes("PULSIFY_API_KEY=")) break;
	}
	const printed = (name: string) =>
		output.match(new RegExp(`^${name}=(.+)$`, "m"))![1]!;
	const url = printed("PULSIFY_URL");
	expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dev$/);
	const client = createCloudClient({
		url,
		credential: printed("PULSIFY_API_KEY"),
	});
	await client.grant({ subject: "alice", prefix: "room", role: "owner" });
	const socket = new WebSocket(
		`${url.replace(/^http/, "ws")}${cloudPath("room", "connect")}`,
		[
			CLOUD_SUBPROTOCOLS[2],
			CLOUD_TOKEN_SUBPROTOCOL +
				(await signCloudToken(
					{ subject: "alice" },
					printed("PULSIFY_TOKEN_SECRET"),
				)),
		],
	);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve);
		socket.addEventListener("error", reject);
	});
	expect(await client.usage("room")).toMatchObject({ connections: 1 });
	// Stopped with a socket open, it still leaves one file per root.
	child.kill("SIGINT");
	expect(await child.exited).toBe(0);
	expect(readdirSync(join(path, "dev"))).toEqual(["room.sqlite"]);
});
