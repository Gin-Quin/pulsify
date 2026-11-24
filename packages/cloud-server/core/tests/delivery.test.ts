import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	decodeMessage,
	definePulse,
	encodeMessage,
	exportPulseUpdates,
	getPulseMeta,
	loadPulse,
	object,
	versioned,
	type PulseMessage,
} from "pulsify-core";
import { MAX_FRAME_BYTES, type PulsePatchRow } from "pulsify-core/protocol";
import {
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	cloudPath,
	createCloudClient,
	createCloudConnector,
	signCloudToken,
} from "pulsify-cloud";
import { eventually, Note } from "./conformance.js";
import { startCloudHost } from "./host.js";

const secrets = {
	tokenSecret: "a test token secret of at least 32 characters",
	apiKey: "a test api key of at least thirty-two characters",
};
let host: ReturnType<typeof startCloudHost>;
beforeAll(() => {
	host = startCloudHost(secrets);
});
afterAll(() => host.stop());
const opened: { close(): void }[] = [];
afterEach(() => {
	host.pressure(undefined);
	for (const item of opened.splice(0)) item.close();
});
const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const sign = (subject: string) =>
	signCloudToken({ subject }, secrets.tokenSecret, { expiresIn: "10m" });
const admin = () =>
	createCloudClient({ url: host.url, credential: secrets.apiKey });

async function raw(root: string, envelope: 1 | 2) {
	const socket = new WebSocket(
		`${host.url.replace(/^http/, "ws")}${cloudPath(root, "connect")}`,
		[
			CLOUD_SUBPROTOCOLS[envelope],
			CLOUD_TOKEN_SUBPROTOCOL + (await sign("alice")),
		],
	);
	opened.push(socket);
	socket.binaryType = "arraybuffer";
	const frames: Uint8Array[] = [];
	socket.addEventListener("message", (event) => {
		if (typeof event.data !== "string")
			frames.push(new Uint8Array(event.data as ArrayBuffer));
	});
	await new Promise((resolve) => socket.addEventListener("open", resolve));
	expect(socket.protocol).toBe(CLOUD_SUBPROTOCOLS[envelope]);
	const messages = () => frames.map((frame) => decodeMessage(frame));
	return { socket, frames, messages };
}
const plain = ({
	docId,
	sid,
	clock,
	span,
	dependencies,
	operations,
}: PulsePatchRow) => ({ docId, sid, clock, span, dependencies, operations });
const rowsOf = (messages: PulseMessage[]) =>
	messages.flatMap((message) =>
		message.kind === 4 ? message.rows.map(plain) : [],
	);

const Big = definePulse(
	"DeliveryBig",
	versioned(object({ title: "string" })),
).materialize();

test("a grouped upload near 8 MiB reaches every envelope, in bounded frames, once per socket", async () => {
	const root = unique("big");
	const docId = `${root}/big`;
	await admin().grant({ subject: "alice", prefix: root, role: "owner" });
	const pulse = createPulse(
		Big,
		{ id: docId, title: "" },
		{ scope: createPulseScope() },
	);
	const base = exportPulseUpdates(pulse, [], { peerVersion: 2 });
	const start = getPulseMeta(pulse).log.vector;
	for (let i = 0; i < 4096; i++) pulse.title = String(i).padStart(2000, "x");
	const [upload, ...more] = exportPulseUpdates(pulse, start, {
		peerVersion: 2,
	});
	// One grouped frame under the limit, whose rows spelled out are over it.
	expect(more).toEqual([]);
	expect(upload![0]).toBe(2);
	expect(upload!.length).toBeLessThan(MAX_FRAME_BYTES);
	const uploaded = decodeMessage(upload!);
	expect(() => encodeMessage(uploaded)).toThrow("8 MiB");

	const writer = await raw(root, 2);
	const modern = await raw(root, 2);
	const legacy = await raw(root, 1);
	const watcher = await raw(root, 1);
	const connect = encodeMessage({ kind: 1, docId, requestId: 1, vv: [] });
	for (const peer of [writer, modern, legacy]) peer.socket.send(connect);
	// Subscribed and watching: the update still arrives once.
	for (const peer of [legacy, watcher])
		peer.socket.send(JSON.stringify({ type: "watch", docId: root }));
	await eventually(() =>
		[writer, modern, legacy].map((peer) => expect(peer.frames).toHaveLength(1)),
	);
	for (const frame of base)
		writer.socket.send(frame as Uint8Array<ArrayBuffer>);
	await eventually(() =>
		[modern, legacy, watcher].map((peer) =>
			expect(rowsOf(peer.messages())).toHaveLength(1),
		),
	);
	for (const peer of [writer, modern, legacy, watcher]) peer.frames.length = 0;

	writer.socket.send(upload as Uint8Array<ArrayBuffer>);
	await eventually(() => expect(writer.frames).toHaveLength(1));
	const [ack] = writer.messages();
	expect(ack).toMatchObject({ kind: 5, vv: getPulseMeta(pulse).log.vector });
	const expected = uploaded.kind === 4 ? uploaded.rows.map(plain) : [];
	await eventually(() =>
		[modern, legacy, watcher].map((peer) =>
			expect(rowsOf(peer.messages()).length).toBe(expected.length),
		),
	);
	await Bun.sleep(50); // Nothing else follows.
	// Envelope 2 gets the frame as it was uploaded.
	expect(modern.frames).toEqual([upload!]);
	// Envelope 1 gets it in chunks, each with the committed vector, in order.
	expect(legacy.frames.length).toBeGreaterThan(1);
	for (const frame of legacy.frames) {
		expect(frame[0]).toBe(1);
		expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
		expect(decodeMessage(frame)).toMatchObject({
			kind: 4,
			requestId: 0,
			vv: ack!.kind === 5 ? ack!.vv : [],
		});
	}
	expect(rowsOf(legacy.messages())).toEqual(expected);
	expect(watcher.frames).toEqual(legacy.frames);
});

test("a frame Bun drops closes the socket, whose client downloads what it missed", async () => {
	const root = unique("pressure");
	await admin().grant({ subject: "alice", prefix: root, role: "owner" });
	const device = () => {
		const connector = createCloudConnector({
			url: host.url,
			token: () => sign("alice"),
			lingerMs: 0,
		});
		opened.push(connector);
		return {
			connectors: [connector],
			scope: createPulseScope(),
			timeoutMs: 5_000,
		};
	};
	const mine = createPulse(
		Note,
		{ id: root, title: "One", body: "" },
		device(),
	);
	await connectPulse(mine).synced;
	const theirs = await loadPulse(Note, root, device());
	connectPulse(theirs);
	await eventually(() => expect(theirs.title).toBe("One"));

	// Queued (-1) is delivered: nothing to recover.
	const sockets = new Set<string>();
	let queued = 0;
	host.pressure((socket, data) => {
		sockets.add(socket.id);
		if (typeof data === "string") return undefined;
		queued++;
		return -1;
	});
	mine.title = "Two";
	await eventually(() => expect(theirs.title).toBe("Two"));
	expect(queued).toBeGreaterThan(0);

	// Dropped (0): the update is lost on that socket, which reconnects.
	let dropped: string | undefined;
	host.pressure((socket, data) => {
		sockets.add(socket.id);
		if (dropped || typeof data === "string") return undefined;
		const message = decodeMessage(data);
		if (message.kind !== 4) return undefined;
		dropped = socket.id;
		return 0;
	});
	mine.title = "Three";
	await eventually(() => expect(dropped).toBeDefined());
	await eventually(() => expect(theirs.title).toBe("Three"));
	// The reader came back on a new socket.
	expect(sockets.size).toBeGreaterThan(2);
});
