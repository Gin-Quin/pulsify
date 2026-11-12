import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	decodePresenceFrame,
	encodeMessage,
	encodePresenceFrame,
	isPresenceFrame,
	PresenceEvent,
} from "pulsify-core/protocol";
import { callerToHeaders, presencePeer } from "pulsify-cloud-server";
import {
	PulsifyCloudRoot,
	ROOT_HEADERS,
	type DurableObjectStateLike,
} from "../source/index.js";

/** What a Durable Object keeps while it hibernates: its storage and its sockets. */
function durableState() {
	const db = new Database(":memory:");
	const sockets: FakeSocket[] = [];
	const state: DurableObjectStateLike = {
		storage: {
			sql: {
				exec: (query, ...bindings) => {
					const rows = db.query(query).all(...(bindings as never[]));
					return { toArray: () => rows as Record<string, unknown>[] };
				},
			},
			transactionSync: (work) => db.transaction(work)(),
		},
		acceptWebSocket: () => {},
		getWebSockets: (tag) =>
			sockets.filter(
				(socket) => !socket.closed && (!tag || socket.attachment["id"] === tag),
			) as never,
	};
	return { state, sockets };
}
type FakeSocket = ReturnType<typeof socket>;
function socket(id: string, subject: string) {
	const fake = {
		attachment: { id, root: "r", subject, envelope: 2 } as Record<
			string,
			unknown
		>,
		sent: [] as (Uint8Array | string)[],
		closed: false,
		// The runtime keeps a structured clone, as a hibernating socket does.
		serializeAttachment(value: unknown) {
			fake.attachment = structuredClone(value) as Record<string, unknown>;
		},
		deserializeAttachment: () => structuredClone(fake.attachment),
		send: (data: Uint8Array | string) => void fake.sent.push(data),
		close: () => void (fake.closed = true),
	};
	return fake;
}
const presence = (fake: FakeSocket) =>
	fake.sent
		.filter(
			(data): data is Uint8Array =>
				typeof data !== "string" && isPresenceFrame(data),
		)
		.map(decodePresenceFrame);
const frame = (event: 0 | 1) =>
	encodePresenceFrame({
		docId: "r/doc",
		peer: 0,
		to: 0,
		event,
		subject: "",
		channel: "cursor#abcd",
		state: event ? new Uint8Array([1]) : new Uint8Array(),
	});
const send = (root: PulsifyCloudRoot, from: FakeSocket, bytes: Uint8Array) =>
	root.webSocketMessage(
		from as never,
		bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	);

test("which sockets use presence survives hibernation, and old clients stay out of it", async () => {
	const { state, sockets } = durableState();
	const awake = new PulsifyCloudRoot(state);
	const granted = await awake.fetch(
		new Request("https://root/grants", {
			method: "PUT",
			headers: {
				[ROOT_HEADERS.root]: "r",
				[ROOT_HEADERS.action]: "grants",
				...callerToHeaders({ kind: "admin" }),
			},
			body: JSON.stringify({ subject: "*", prefix: "r", role: "reader" }),
		}),
	);
	expect(granted.status).toBe(200);
	const a = socket("a", "ada"),
		b = socket("b", "grace"),
		old = socket("old", "old client");
	sockets.push(a, b, old);
	for (const each of sockets)
		await send(
			awake,
			each,
			encodeMessage({ kind: 1, docId: "r/doc", requestId: 1, vv: [] }),
		);
	await send(awake, a, frame(0));
	await send(awake, b, frame(0));
	expect(a.attachment["presence"]).toBe(true);
	expect(b.attachment["presence"]).toBe(true);
	expect(old.attachment["presence"]).toBeUndefined();
	expect(presence(a)).toMatchObject([{ peer: presencePeer("b"), event: 0 }]);

	// The object hibernates: a new instance, the same storage and sockets.
	const woken = new PulsifyCloudRoot(state);
	a.sent.length = b.sent.length = old.sent.length = 0;
	await send(woken, a, frame(1));
	expect(presence(b)).toMatchObject([
		{ peer: presencePeer("a"), subject: "ada", event: PresenceEvent.state },
	]);
	expect(presence(a)).toEqual([]);
	expect(old.sent).toEqual([]);

	// A socket that closes is announced to the sockets that use presence only.
	a.closed = true;
	await woken.webSocketClose(a as never, 1000, "");
	expect(presence(b).at(-1)).toMatchObject({
		peer: presencePeer("a"),
		event: PresenceEvent.leave,
	});
	expect(old.sent).toEqual([]);
});
