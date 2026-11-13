import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { serialize } from "node:v8";
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
	/** The subscriptions in storage, as `connection docId role`. */
	const stored = () =>
		(
			db
				.query(
					"SELECT connection, doc_id, role FROM pulsify_cloud_subscriptions ORDER BY connection, doc_id",
				)
				.all() as { connection: string; doc_id: string; role: string }[]
		).map((row) => `${row.connection} ${row.doc_id} ${row.role}`);
	return { state, sockets, db, stored };
}
const admin = (
	root: PulsifyCloudRoot,
	method: "PUT" | "DELETE",
	grant: { subject: string; prefix: string; role?: string },
) =>
	root.fetch(
		new Request(
			`https://root/grants?subject=${encodeURIComponent(grant.subject)}&prefix=${grant.prefix}`,
			{
				method,
				headers: {
					[ROOT_HEADERS.root]: "r",
					[ROOT_HEADERS.action]: "grants",
					...callerToHeaders({ kind: "admin" }),
				},
				...(method === "PUT" ? { body: JSON.stringify(grant) } : {}),
			},
		),
	);
type FakeSocket = ReturnType<typeof socket>;
function socket(id: string, subject: string) {
	const fake = {
		attachment: { id, root: "r", subject, envelope: 2 } as Record<
			string,
			unknown
		>,
		sent: [] as (Uint8Array | string)[],
		closed: false,
		// The runtime keeps a structured clone, as a hibernating socket does,
		// and refuses one over its size limit.
		serializeAttachment(value: unknown) {
			if (serialize(value).byteLength > 16_384)
				throw new Error(
					"A WebSocket 'attachment' cannot be larger than 16384 bytes.",
				);
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
const subscribed = (fake: FakeSocket) =>
	(fake.attachment["subscriptions"] as Map<string, string> | undefined) ??
	new Map<string, string>();
const roles = (fake: FakeSocket) =>
	fake.sent
		.filter((data) => typeof data === "string")
		.map((data) => JSON.parse(data) as { docId: string; role: string | null })
		.map(({ docId, role }) => `${docId} ${role}`);
const connect = (docId: string) =>
	encodeMessage({ kind: 1, docId, requestId: 1, vv: [] });
const send = (root: PulsifyCloudRoot, from: FakeSocket, bytes: Uint8Array) =>
	root.webSocketMessage(
		from as never,
		bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	);

test("which sockets use presence survives hibernation, and old clients stay out of it", async () => {
	const { state, sockets, stored } = durableState();
	const awake = new PulsifyCloudRoot(state);
	const granted = await admin(awake, "PUT", {
		subject: "*",
		prefix: "r",
		role: "reader",
	});
	expect(granted.status).toBe(200);
	const a = socket("a", "ada"),
		b = socket("b", "grace"),
		old = socket("old", "old client");
	sockets.push(a, b, old);
	for (const each of sockets) await send(awake, each, connect("r/doc"));
	// Subscriptions hibernate with their socket: nothing is written for them.
	expect(subscribed(a)).toEqual(new Map([["r/doc", "reader"]]));
	expect(stored()).toEqual([]);
	await send(awake, a, frame(0));
	await send(awake, b, frame(0));
	expect(a.attachment["presence"]).toBe(true);
	expect(b.attachment["presence"]).toBe(true);
	expect(old.attachment["presence"]).toBe(false);
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

test("subscriptions over the attachment limit are stored, and grant changes after hibernation reach them all", async () => {
	const { state, sockets, stored } = durableState();
	let root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "reader" });
	const a = socket("a", "ada");
	sockets.push(a);
	// Document IDs go up to 1,024 UTF-16 units: 40 of them cannot fit.
	const documents = Array.from(
		{ length: 40 },
		(_, index) => `r/${"d".repeat(1000)}${index}`,
	);
	for (const docId of documents) await send(root, a, connect(docId));
	const overflow = stored().length;
	expect(overflow).toBeGreaterThan(0);
	expect(subscribed(a).size).toBeGreaterThan(0);
	expect(subscribed(a).size + overflow).toBe(40);

	// One from each side ends: the other subscriptions stay where they are.
	const [kept] = subscribed(a).keys();
	const spilled = documents.at(-1)!;
	expect(stored().includes(`a ${spilled} reader`)).toBe(true);
	for (const docId of [kept, spilled])
		await root.webSocketMessage(
			a as never,
			JSON.stringify({ type: "unsubscribe", docId }),
		);
	expect(a.closed).toBe(false);
	expect(subscribed(a).size + stored().length).toBe(38);
	expect(stored()).toHaveLength(overflow - 1);
	const remaining = documents.filter(
		(docId) => docId !== kept && docId !== spilled,
	);

	root = new PulsifyCloudRoot(state);
	a.sent.length = 0;
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "editor" });
	expect(roles(a).sort()).toEqual(
		remaining.map((docId) => `${docId} editor`).sort(),
	);
	expect(new Set(subscribed(a).values())).toEqual(new Set(["editor"]));
	expect(stored()).toHaveLength(overflow - 1);
	expect(stored().every((row) => row.endsWith(" editor"))).toBe(true);

	root = new PulsifyCloudRoot(state);
	a.sent.length = 0;
	await admin(root, "DELETE", { subject: "ada", prefix: "r" });
	expect(roles(a).sort()).toEqual(
		remaining.map((docId) => `${docId} null`).sort(),
	);
	expect(subscribed(a).size).toBe(0);
	expect(stored()).toEqual([]);
});

test("a socket that closes while its root sleeps takes its stored subscriptions with it", async () => {
	const { state, sockets, stored } = durableState();
	const awake = new PulsifyCloudRoot(state);
	await admin(awake, "PUT", { subject: "*", prefix: "r", role: "reader" });
	const a = socket("a", "ada"),
		b = socket("b", "grace");
	sockets.push(a, b);
	const big = `r/${"d".repeat(1000)}`;
	for (let index = 0; index < 40; index++)
		await send(awake, a, connect(big + index));
	for (const each of sockets) {
		await send(awake, each, connect("r/doc"));
		await send(awake, each, frame(0));
	}
	expect(stored().length).toBeGreaterThan(0);

	const woken = new PulsifyCloudRoot(state);
	b.sent.length = 0;
	a.closed = true;
	await woken.webSocketClose(a as never, 1006, "");
	expect(presence(b)).toMatchObject([
		{ docId: "r/doc", peer: presencePeer("a"), event: PresenceEvent.leave },
	]);
	expect(stored()).toEqual([]);
});

test("subscriptions stored by an earlier version are honoured until they end", async () => {
	const { state, sockets, db, stored } = durableState();
	const awake = new PulsifyCloudRoot(state);
	await admin(awake, "PUT", { subject: "*", prefix: "r", role: "reader" });
	const a = socket("a", "ada"),
		b = socket("b", "grace");
	sockets.push(a, b);
	await send(awake, a, connect("r/doc"));
	await send(awake, a, frame(0));
	// What the earlier version left: a row per subscription, none in attachments.
	b.attachment["presence"] = true;
	for (const connection of ["b", "gone"])
		db.query(
			"INSERT INTO pulsify_cloud_subscriptions(connection, doc_id, role) VALUES(?, 'r/doc', 'reader')",
		).run(connection);

	const woken = new PulsifyCloudRoot(state);
	a.sent.length = b.sent.length = 0;
	await send(woken, a, frame(1));
	// The socket that closed during the upgrade is announced and forgotten.
	const gone = { peer: presencePeer("gone"), event: PresenceEvent.leave };
	expect(presence(a)).toMatchObject([gone]);
	expect(presence(b)).toMatchObject([
		gone,
		{ peer: presencePeer("a"), event: PresenceEvent.state },
	]);
	expect(stored()).toEqual(["b r/doc reader"]);

	await admin(woken, "PUT", { subject: "grace", prefix: "r", role: "editor" });
	expect(roles(b)).toEqual(["r/doc editor"]);
	expect(stored()).toEqual(["b r/doc editor"]);
	expect(subscribed(b).size).toBe(0);

	b.closed = true;
	await woken.webSocketClose(b as never, 1000, "");
	expect(presence(a).at(-1)).toMatchObject({
		peer: presencePeer("b"),
		event: PresenceEvent.leave,
	});
	expect(stored()).toEqual([]);
});
