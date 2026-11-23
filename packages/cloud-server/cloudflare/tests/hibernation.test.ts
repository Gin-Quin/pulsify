import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { serialize } from "node:v8";
import {
	decodeMessage,
	decodePresenceFrame,
	encodeMessage,
	encodePresenceFrame,
	isPresenceFrame,
	PresenceEvent,
} from "pulsify-core/protocol";
import { SqlitePatchStore, type StoredPatchRow } from "pulsify-core/storage";
import { callerToHeaders, presencePeer } from "pulsify-cloud-server";
import {
	COMPACT_AFTER_MS,
	PulsifyCloudRoot,
	ROOT_HEADERS,
	type DurableObjectStateLike,
} from "../source/index.js";

/** What a Durable Object keeps while it hibernates: its storage and its sockets. */
function durableState() {
	const db = new Database(":memory:");
	const sockets: FakeSocket[] = [];
	/** When the object's alarm is due, once one is set. */
	const alarm: { at?: number } = {};
	const state: DurableObjectStateLike = {
		storage: {
			sql: {
				exec: (query, ...bindings) => {
					const rows = db.query(query).all(...(bindings as never[])) as Record<
						string,
						unknown
					>[];
					// The runtime returns a BLOB as an ArrayBuffer.
					for (const row of rows)
						for (const [name, value] of Object.entries(row))
							if (value instanceof Uint8Array)
								row[name] = value.buffer.slice(
									value.byteOffset,
									value.byteOffset + value.byteLength,
								);
					return { toArray: () => rows };
				},
			},
			transactionSync: (work) => db.transaction(work)(),
			setAlarm: (time) => void (alarm.at = time),
			deleteAlarm: () => void delete alarm.at,
			deleteAll: () => {
				for (const { type, name } of db
					.query(
						"SELECT type, name FROM sqlite_master WHERE type IN ('view', 'table')",
					)
					.all() as { type: string; name: string }[])
					db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`);
			},
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
	return { state, sockets, db, stored, alarm };
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

/** A history of two actors, written straight to the root's database. */
async function seedHistory(db: Database, docId: string, length: number) {
	const rows = (sid: number): StoredPatchRow[] =>
		Array.from({ length }, (_, index) => ({
			docId,
			sid,
			clock: index + 1,
			span: 1,
			dependencies: index ? [[sid, index + 1]] : [],
			operations: new Uint8Array([sid & 255, index & 255, index >> 8]),
		}));
	const store = new SqlitePatchStore(db);
	for (const sid of [70001, 70002]) await store.append(rows(sid));
}
const rowCount = (db: Database, where = "1") =>
	(
		db
			.query(`SELECT COUNT(*) AS count FROM pulsify_op_rows WHERE ${where}`)
			.get() as { count: number }
	).count;
/** Everything a fresh socket is sent when it asks for the whole document. */
async function coldLoad(
	root: PulsifyCloudRoot,
	sockets: FakeSocket[],
	id: string,
) {
	const fresh = socket(id, "ada");
	sockets.push(fresh);
	await send(root, fresh, connect("r/doc"));
	return fresh;
}

test("the last disconnect arms an alarm that compacts the root's history once it stayed idle", async () => {
	const { state, sockets, db, alarm } = durableState();
	let root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "*", prefix: "r", role: "editor" });
	await seedHistory(db, "r/doc", 3000);
	await seedHistory(db, "r/small", 20);
	const a = await coldLoad(root, sockets, "a"),
		b = await coldLoad(root, sockets, "b");
	expect(a.sent.length).toBeGreaterThan(2);

	// Not the last socket: the root stays as it is.
	b.closed = true;
	await root.webSocketClose(b as never, 1000, "");
	expect(alarm.at).toBeUndefined();
	// The runtime still lists a socket while it reports that it closed.
	const before = Date.now();
	await root.webSocketClose(a as never, 1000, "");
	a.closed = true;
	expect(alarm.at).toBeGreaterThanOrEqual(before + COMPACT_AFTER_MS);
	expect(alarm.at).toBeLessThanOrEqual(Date.now() + COMPACT_AFTER_MS);
	expect(rowCount(db)).toBe(6040);

	// The alarm wakes an evicted object. It works in bounded steps, each of
	// which sets the next, until nothing is left.
	root = new PulsifyCloudRoot(state);
	let steps = 0;
	for (; alarm.at !== undefined; steps++) {
		if (steps) expect(alarm.at).toBeLessThan(Date.now() + 1000);
		delete alarm.at;
		await root.alarm();
	}
	expect(steps).toBe(2);
	expect(rowCount(db, "doc_id='r/doc'")).toBe(2);
	expect(rowCount(db, "doc_id='r/doc' AND packed=1")).toBe(2);
	// A document with few rows is left alone.
	expect(rowCount(db, "doc_id='r/small' AND packed=0")).toBe(40);

	// A fresh client gets the very frames it got before the compaction.
	const fresh = await coldLoad(root, sockets, "fresh");
	expect(fresh.sent).toEqual(a.sent);
	// Its updates go on, in order and resent.
	const update = encodeMessage({
		kind: 4,
		docId: "r/doc",
		requestId: 2,
		vv: [[70001, 3002]],
		rows: [
			{
				docId: "r/doc",
				sid: 70001,
				clock: 3001,
				span: 1,
				dependencies: [[70001, 3001]],
				operations: new Uint8Array([1]),
			},
		],
	});
	fresh.sent.length = 0;
	await send(root, fresh, update);
	await send(root, fresh, update);
	expect(fresh.closed).toBe(false);
	expect(fresh.sent).toHaveLength(2);
	expect(rowCount(db, "doc_id='r/doc'")).toBe(3);
});

test("a root that got a socket back before its alarm does not compact", async () => {
	const { state, sockets, db, alarm } = durableState();
	const root = new PulsifyCloudRoot(state, { PULSIFY_COMPACT_AFTER_MS: "250" });
	await admin(root, "PUT", { subject: "*", prefix: "r", role: "editor" });
	await seedHistory(db, "r/doc", 200);
	const a = await coldLoad(root, sockets, "a");
	a.closed = true;
	const before = Date.now();
	await root.webSocketError(a as never);
	// The debounce can be shortened by configuration.
	expect(alarm.at).toBeGreaterThanOrEqual(before + 250);
	expect(alarm.at).toBeLessThanOrEqual(Date.now() + 250);

	const b = await coldLoad(root, sockets, "b");
	delete alarm.at;
	await root.alarm();
	expect(alarm.at).toBeUndefined();
	expect(rowCount(db)).toBe(400);

	// Its next last disconnect sets the alarm again.
	b.closed = true;
	await root.webSocketClose(b as never, 1000, "");
	expect(alarm.at).toBeDefined();
	await root.alarm();
	expect(rowCount(db)).toBe(2);
});

test("deleting a document ends its sessions, and deleting the root retains its permanent tombstone", async () => {
	const { state, sockets, db, alarm } = durableState();
	const root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "owner" });
	await admin(root, "PUT", { subject: "bob", prefix: "r/doc", role: "editor" });
	const a = socket("a", "ada");
	sockets.push(a);
	const row = (docId: string) =>
		encodeMessage({
			kind: 4,
			docId,
			requestId: 2,
			vv: [[70001, 2]],
			rows: [
				{
					docId,
					sid: 70001,
					clock: 1,
					span: 1,
					dependencies: [],
					operations: new Uint8Array([1]),
				},
			],
		});
	for (const docId of ["r", "r/doc", "r/doc/child", "r/docx"]) {
		await send(root, a, connect(docId));
		await send(root, a, row(docId));
	}
	const documents = () =>
		(
			db
				.query("SELECT DISTINCT doc_id FROM pulsify_op_rows ORDER BY doc_id")
				.all() as { doc_id: string }[]
		).map((row) => row.doc_id);
	expect(documents()).toEqual(["r", "r/doc", "r/doc/child", "r/docx"]);
	const remove = (docId: string) =>
		root.fetch(
			new Request(`https://root/documents?docId=${encodeURIComponent(docId)}`, {
				method: "DELETE",
				headers: {
					[ROOT_HEADERS.root]: "r",
					[ROOT_HEADERS.action]: "documents",
					...callerToHeaders({ kind: "admin" }),
				},
			}),
		);

	a.sent.length = 0;
	expect(await (await remove("r/doc")).json()).toEqual({ deleted: 2 });
	expect(documents()).toEqual(["r", "r/docx"]);
	expect([...subscribed(a).keys()].sort()).toEqual(["r", "r/docx"]);
	const errors = a.sent
		.filter((data): data is Uint8Array => typeof data !== "string")
		.map((data) => decodeMessage(data));
	expect(errors).toMatchObject([
		{ kind: 6, docId: "r/doc", code: "NOT_FOUND" },
		{ kind: 6, docId: "r/doc/child", code: "NOT_FOUND" },
	]);
	expect(
		db.query("SELECT subject, prefix FROM pulsify_cloud_grants").all(),
	).toEqual([{ subject: "ada", prefix: "r" }]);

	// Deleting the root closes its sockets but retains the marker across hibernation.
	expect(await (await remove("r")).json()).toEqual({ deleted: 2 });
	expect(a.closed).toBe(true);
	expect(alarm.at).toBeUndefined();
	expect(db.query("SELECT prefix FROM pulsify_tombstones").all()).toEqual([
		{ prefix: "r" },
	]);
	expect(db.query("SELECT * FROM pulsify_op_rows").all()).toEqual([]);
	// Its close event does not bring the storage back.
	await root.webSocketClose(a as never, 1000, "");
	expect(db.query("SELECT prefix FROM pulsify_tombstones").all()).toEqual([
		{ prefix: "r" },
	]);
	expect(db.query("SELECT * FROM pulsify_op_rows").all()).toEqual([]);
	expect(alarm.at).toBeUndefined();
	const awakened = new PulsifyCloudRoot(state);
	const response = await admin(awakened, "PUT", {
		subject: "ada",
		prefix: "r",
		role: "owner",
	});
	expect(response.status).toBe(404);
	expect(await new SqlitePatchStore(db).isDeleted("r/offline/new")).toBe(true);
});

test("cloud.expire erases the whole root once it stayed without sockets, for an owner or the API key", async () => {
	const { state, sockets, db, alarm } = durableState();
	const root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "owner" });
	await admin(root, "PUT", { subject: "bob", prefix: "r", role: "editor" });
	const expire = (
		caller: Parameters<typeof callerToHeaders>[0],
		body: unknown,
		method = "PUT",
	) =>
		root.fetch(
			new Request("https://root/expire", {
				method,
				headers: {
					[ROOT_HEADERS.root]: "r",
					[ROOT_HEADERS.action]: "expire",
					...callerToHeaders(caller),
				},
				...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
			}),
		);
	const day = 86_400_000;
	expect(
		(await expire({ kind: "user", subject: "bob" }, { idleMs: day })).status,
	).toBe(403);
	expect((await expire({ kind: "admin" }, { idleMs: 1000 })).status).toBe(400);
	expect((await expire({ kind: "admin" }, { idleMs: "1d" })).status).toBe(400);
	expect((await expire({ kind: "admin" }, {}, "GET")).status).toBe(405);
	expect(alarm.at).toBeUndefined();

	// Nobody is connected: it counts from now.
	const response = await expire(
		{ kind: "user", subject: "ada" },
		{ idleMs: day },
	);
	expect(await response.json()).toEqual({ idleMs: day });
	expect(alarm.at).toBeGreaterThanOrEqual(Date.now() + day - 1000);

	// A socket comes and goes: the lifetime starts again when it leaves.
	const a = socket("a", "bob");
	sockets.push(a);
	await send(root, a, connect("r"));
	await root.alarm(); // due while the socket is open: nothing happens
	expect(
		db.query("SELECT COUNT(*) AS n FROM pulsify_cloud_grants").get(),
	).toEqual({ n: 2 });
	delete alarm.at;
	const before = Date.now();
	await root.webSocketClose(a as never, 1000, "");
	a.closed = true;
	expect(alarm.at).toBeGreaterThanOrEqual(before + day);

	// Its alarm erases everything the object stores, and leaves no alarm.
	await new PulsifyCloudRoot(state).alarm();
	expect(
		db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
	).toEqual([]);
	expect(alarm.at).toBeUndefined();
});

test("a root left with no document, grant or tombstone wipes itself once idle", async () => {
	const { state, sockets, db, alarm } = durableState();
	const tables = () =>
		db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();

	// A link opened after its room was erased: no grant, so nothing is written.
	let root = new PulsifyCloudRoot(state);
	const late = socket("late", "demo");
	sockets.push(late);
	await send(root, late, connect("r"));
	expect(tables().length).toBeGreaterThan(0);
	await root.webSocketClose(late as never, 1000, "");
	late.closed = true;
	expect(alarm.at).toBeDefined();
	delete alarm.at;
	await new PulsifyCloudRoot(state).alarm();
	expect(tables()).toEqual([]);

	// A grant alone is something to keep: the alarm only compacts.
	root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "owner" });
	await root.alarm();
	expect(db.query("SELECT subject FROM pulsify_cloud_grants").all()).toEqual([
		{ subject: "ada" },
	]);
});

test("the account of an actor and of its writes survives hibernation, through the object's own requests", async () => {
	const { state, sockets, db } = durableState();
	let root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "*", prefix: "r", role: "editor" });
	const ask = async (
		object: PulsifyCloudRoot,
		action: "actors" | "authors",
		subject: string,
		actor?: number,
	) =>
		(
			await object.fetch(
				new Request(
					`https://root/${action}?docId=r/doc${actor ? `&actor=${actor}` : ""}`,
					{
						headers: {
							[ROOT_HEADERS.root]: "r",
							[ROOT_HEADERS.action]: action,
							...callerToHeaders({ kind: "user", subject }),
						},
					},
				),
			)
		).json();
	const write = (sid: number, clock: number) =>
		encodeMessage({
			kind: 3,
			docId: "r/doc",
			requestId: clock + 1,
			vv: [],
			rows: [
				{
					docId: "r/doc",
					sid,
					clock,
					span: 1,
					dependencies: clock > 1 ? [[sid, clock]] : [],
					operations: new Uint8Array([clock]),
				},
			],
		});
	const a = socket("a", "ada"),
		b = socket("b", "grace");
	sockets.push(a, b);
	for (const each of sockets) await send(root, each, connect("r/doc"));
	await root.webSocketMessage(
		a as never,
		JSON.stringify({ type: "actors", docId: "r/doc", actors: [70001] }),
	);
	await send(root, a, write(70001, 1));
	expect(await ask(root, "actors", "grace", 70001)).toEqual({ subject: "ada" });

	// The object hibernates: a new instance, the same storage and sockets.
	// Ada writes on without declaring her actor again, and Grace cannot take
	// it: all of it is in storage.
	root = new PulsifyCloudRoot(state);
	await send(root, a, write(70001, 2));
	b.sent.length = 0;
	await root.webSocketMessage(
		b as never,
		JSON.stringify({ type: "actors", docId: "r/doc", actors: [70001] }),
	);
	expect(b.sent.filter((data) => typeof data === "string")).toEqual([
		JSON.stringify({ type: "actors", docId: "r/doc", refused: [70001] }),
	]);
	await send(root, b, write(70001, 3));
	root = new PulsifyCloudRoot(state);
	expect(await ask(root, "actors", "grace", 70001)).toEqual({ subject: "ada" });
	expect(await ask(root, "actors", "grace", 70002)).toEqual({ subject: null });
	expect(await ask(root, "authors", "grace")).toEqual({
		actors: [[70001, "ada"]],
		received: [
			{ actor: 70001, clock: 1, end: 3, subject: "ada" },
			{ actor: 70001, clock: 3, end: 4, subject: "grace" },
		],
	});
	expect(rowCount(db, "doc_id='r/doc'")).toBe(3);
});

test("descendant watches survive hibernation and push newly created sub-documents", async () => {
	const { state, sockets } = durableState();
	let root = new PulsifyCloudRoot(state);
	await admin(root, "PUT", { subject: "ada", prefix: "r", role: "owner" });
	await admin(root, "PUT", { subject: "grace", prefix: "r", role: "reader" });

	const a = socket("a", "ada");
	const b = socket("b", "grace");
	sockets.push(a, b);
	await root.webSocketMessage(
		b as never,
		JSON.stringify({ type: "watch", docId: "r" }),
	);
	expect(b.attachment["watches"]).toEqual(new Set(["r"]));

	// The Durable Object hibernates and wakes up as a fresh instance.
	root = new PulsifyCloudRoot(state);
	await send(root, a, connect("r/new-note"));
	b.sent.length = 0;
	await send(
		root,
		a,
		encodeMessage({
			kind: 3,
			docId: "r/new-note",
			requestId: 2,
			vv: [],
			rows: [
				{
					docId: "r/new-note",
					sid: 70001,
					clock: 1,
					span: 1,
					dependencies: [],
					operations: new Uint8Array([1, 2, 3]),
				},
			],
		}),
	);
	const pushed = b.sent
		.filter((data): data is Uint8Array => data instanceof Uint8Array)
		.map((bytes) => decodeMessage(bytes));
	expect(pushed).toMatchObject([
		{ kind: 4, docId: "r/new-note", requestId: 0, rows: [{ clock: 1 }] },
	]);
});

test("S10 & S11: waking root skips DDL and idle alarm checks emptiness with EXISTS once per idle period", async () => {
	const { state, db, alarm } = durableState();
	// Initialize schema and seed enough rows for multiple compaction steps.
	const initial = new PulsifyCloudRoot(state);
	await admin(initial, "PUT", { subject: "*", prefix: "r", role: "editor" });
	await seedHistory(db, "r/doc", 3000);

	const queries: string[] = [];
	const origExec = state.storage.sql.exec;
	state.storage.sql.exec = (query: string, ...bindings: unknown[]) => {
		queries.push(query);
		return origExec(query, ...bindings);
	};

	// Waking an already-initialized root runs no DDL statements.
	const woken = new PulsifyCloudRoot(state);
	alarm.at = Date.now();
	let steps = 0;
	while (alarm.at !== undefined) {
		delete alarm.at;
		await woken.alarm();
		steps++;
	}
	expect(steps).toBeGreaterThanOrEqual(2);
	expect(queries.filter((q) => /\b(CREATE|DROP)\b/i.test(q))).toEqual([]);
	expect(queries.filter((q) => q.includes("COUNT(DISTINCT doc_id)"))).toEqual(
		[],
	);
	expect(
		queries.filter((q) =>
			q.includes("EXISTS(SELECT 1 FROM pulsify_op_rows LIMIT 1)"),
		),
	).toHaveLength(1);
});
