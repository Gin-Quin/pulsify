import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { eventually } from "../../cloud-server/core/tests/conformance.js";
import { startLocalCloud } from "../../cloud-server/local/source/index.js";
import { RootMeter } from "../source/meter.js";
import type { RootReport, RootStatus } from "../source/Project.js";

const secrets = {
	tokenSecret: "a test token secret of at least 32 characters",
	apiKey: "a test api key of at least thirty-two characters",
};
const Note = definePulse(
	"MeteredNote",
	object({ title: "string" }),
).materialize();

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// The meter is the service's part of a root. It runs here on the local
// server, without Durable Objects: any host that calls a CloudMeter will do.
test("a root's meter reports to its project and enforces its plan on another host", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pulsify-meter-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const reports: (RootReport & { project: string })[] = [];
	const status: RootStatus = { writable: true, connectable: true };
	const server = startLocalCloud({
		directory,
		port: 0,
		secrets,
		meter: (project, root) =>
			new RootMeter(root, async (report) => {
				reports.push({ ...report, project });
				return { ...status };
			}),
	});
	cleanups.push(() => server.stop());
	const url = `${server.url}/abcdefghijklmnop`;
	const sign = () => signCloudToken({ subject: "alice" }, secrets.tokenSecret);
	const device = () => {
		const connector = createCloudConnector({ url, token: sign, lingerMs: 0 });
		cleanups.push(() => connector.close());
		const errors: Error[] = [];
		return {
			connector,
			errors,
			options: {
				connectors: [connector],
				scope: createPulseScope(),
				timeoutMs: 5_000,
				onError: (error: Error) => errors.push(error),
			},
		};
	};
	const socket = async () => {
		const socket = new WebSocket(
			`${url.replace(/^http/, "ws")}${cloudPath("room", "connect")}`,
			[CLOUD_SUBPROTOCOLS[2], CLOUD_TOKEN_SUBPROTOCOL + (await sign())],
		);
		cleanups.push(() => socket.close());
		return new Promise<boolean>((resolve) => {
			socket.addEventListener("open", () => resolve(true));
			socket.addEventListener("error", () => resolve(false));
			socket.addEventListener("close", () => resolve(false));
		});
	};

	// A root used only over HTTP reports too.
	await createCloudClient({ url, credential: secrets.apiKey }).grant({
		subject: "alice",
		prefix: "room",
		role: "owner",
	});
	expect(reports).toMatchObject([
		{ project: "abcdefghijklmnop", root: "room", messages: 0, connections: 0 },
	]);
	expect(reports[0]!.bytes).toBeGreaterThan(0);

	// A socket is counted when it asks to open, its frames with the next report.
	const a = device();
	const note = createPulse(Note, { id: "room", title: "Stored" }, a.options);
	await connectPulse(note).synced;
	expect(reports.at(-1)).toMatchObject({ connections: 1 });
	expect(await socket()).toBe(true);
	expect(reports.at(-1)).toMatchObject({ connections: 2 });
	expect(reports.at(-1)!.messages).toBeGreaterThan(0);

	// Over the Free limits: the root learns it with a report, then refuses uploads.
	status.writable = false;
	expect(await socket()).toBe(true);
	note.title = "Refused";
	await eventually(() =>
		expect(
			a.errors.map((error) => (error as { code?: string }).code),
		).toContain("LIMIT_EXCEEDED"),
	);
	const b = device();
	expect((await loadPulse(Note, "room", b.options)).title).toBe("Stored");

	// Over the plan's connections: no more sockets.
	status.connectable = false;
	expect(await socket()).toBe(false);

	// Closing reports what is left.
	const before = reports.length;
	a.connector.close();
	b.connector.close();
	await eventually(() => expect(reports.length).toBeGreaterThan(before));
	await eventually(() => expect(reports.at(-1)!.connections).toBe(2));
});
