import { afterEach, describe, expect, test } from "bun:test";
import {
	array,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	decodeMessage,
	definePulse,
	destroyPulse,
	disconnectPulse,
	encodeMessage,
	getPulseMeta,
	loadPulse,
	object,
	optional,
	PulseRelay,
	richText,
	snapshotPulse,
	sub,
	pulseRef,
	type Pulse,
} from "pulsify-core";
import type { ConnectorSession } from "pulsify-core";
import { forceCloseDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
	createIndexedDbConnector,
	type IndexedDbConnector,
} from "../source/index";

const Task = definePulse(
	"Task",
	object({ title: "string", done: "boolean" }),
).materialize();
const Note = definePulse(
	"Note",
	object({
		title: "string",
		body: richText(),
		tags: array("string"),
		items: array(object({ value: "float64" })),
		tasks: array(sub(Task)),
		pinned: optional(sub(Task)),
	}),
).materialize();
const note = (id = crypto.randomUUID()) => ({
	id,
	title: "Draft",
	body: "Hello",
	tags: ["a"],
	items: [{ value: 1 }],
	tasks: [],
});

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});
function track<P extends Pulse<any>>(pulse: P): P {
	cleanup.push(() => destroyPulse(pulse));
	return pulse;
}
/** One browser profile: every connector opened on it shares the same database. */
function profile() {
	const indexedDB = new IDBFactory(),
		name = crypto.randomUUID();
	return () => {
		const connector = createIndexedDbConnector({
			name,
			indexedDB,
			IDBKeyRange,
		});
		cleanup.push(() => connector.close());
		return connector;
	};
}
async function eventually(
	assertion: () => void | Promise<void>,
	timeout = 2000,
): Promise<void> {
	const end = performance.now() + timeout;
	while (true) {
		try {
			await assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
/** Resolves once the store holds everything the pulse has. */
const persisted = (connector: IndexedDbConnector, pulse: Pulse<any>) =>
	eventually(async () =>
		expect(await connector.store.vector(pulse.id)).toEqual(
			getPulseMeta(pulse).log.vector,
		),
	);
const signal = () => new AbortController().signal;

describe("IndexedDB connector", () => {
	test("documents survive a reload: values, rich text, arrays and sub-pulses", async () => {
		const open = profile();
		const first = open();
		const scope = createPulseScope();
		const doc = track(
			createPulse(Note, note(), { scope, connectors: [first] }),
		);
		await connectPulse(doc).synced;
		const task = track(
			createPulse(Task, { title: "Ship", done: false }, { parent: doc }),
		);
		await connectPulse(task).synced;
		doc.tasks.push(pulseRef(task));
		doc.pinned = pulseRef(task);
		doc.title = "Final";
		doc.body.insert(5, " world", { bold: true });
		doc.body.delete(0, 1);
		doc.tags.push("b", "c");
		doc.items[0]!.value = 7;
		doc.items.unshift({ value: 3 });
		task.done = true;
		await persisted(first, doc);
		await persisted(first, task);
		const expected = snapshotPulse(doc);
		const delta = doc.body.toDelta();
		destroyPulse(doc);
		destroyPulse(task);
		first.close();

		const reloaded = open();
		const loaded = track(
			await loadPulse(Note, expected.id, {
				scope: createPulseScope(),
				connectors: [reloaded],
			}),
		);
		expect(snapshotPulse(loaded)).toEqual(expected);
		expect(loaded.title).toBe("Final");
		expect(loaded.body.text).toBe("ello world");
		expect(loaded.body.toDelta()).toEqual(delta);
		expect(loaded.tags).toEqual(["a", "b", "c"]);
		expect(loaded.items.map((item) => item.value)).toEqual([3, 7]);
		const child = loaded.tasks[0]!.pulse!;
		track(child);
		expect(child.title).toBe("Ship");
		expect(child.done).toBe(true);
		expect(loaded.pinned?.id).toBe(child.id);

		// Editing after the reload appends to the same local history.
		loaded.body.insert(0, "H");
		await persisted(reloaded, loaded);
		destroyPulse(loaded);
		const again = track(
			await loadPulse(Note, expected.id, {
				scope: createPulseScope(),
				connectors: [open()],
			}),
		);
		expect(again.body.text).toBe("Hello world");
	});

	test("missing documents are reported as not found", async () => {
		const open = profile();
		await expect(
			loadPulse(Note, "missing", {
				scope: createPulseScope(),
				connectors: [open()],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("offline edits are persisted and uploaded once the remote is reachable", async () => {
		const open = profile();
		const relay = new PulseRelay();
		const remote = createMemoryConnector(relay, "remote");
		const local = open();
		const doc = track(
			createPulse(Note, note(), {
				scope: createPulseScope(),
				connectors: [local],
			}),
		);
		await connectPulse(doc).synced;
		doc.title = "Written offline";
		doc.body.insert(5, "!");
		doc.items.push({ value: 2 });
		await persisted(local, doc);
		expect(relay.getLog(doc.id)).toBeUndefined();
		const id = doc.id,
			expected = snapshotPulse(doc);
		destroyPulse(doc);
		local.close();

		const online = open();
		const reloaded = track(
			await loadPulse(Note, id, {
				scope: createPulseScope(),
				connectors: [online, remote],
				waitFor: "all",
			}),
		);
		expect(snapshotPulse(reloaded)).toEqual(expected);
		expect(relay.getLog(id)!.vector).toEqual(getPulseMeta(reloaded).log.vector);

		// Another device sees the upload; its edits flow back into IndexedDB.
		const other = track(
			await loadPulse(Note, id, {
				scope: createPulseScope(),
				connectors: [createMemoryConnector(relay, "remote")],
				waitFor: "all",
			}),
		);
		expect(other.title).toBe("Written offline");
		other.tags.push("remote");
		await eventually(() => expect(reloaded.tags).toEqual(["a", "remote"]));
		await persisted(online, reloaded);
		destroyPulse(reloaded);
		online.close();

		const offline = track(
			await loadPulse(Note, id, {
				scope: createPulseScope(),
				connectors: [open()],
			}),
		);
		expect(offline.tags).toEqual(["a", "remote"]);
	});

	test("sessions of one connector see each other's updates", async () => {
		const connector = profile()();
		const a = track(
			createPulse(Note, note(), {
				scope: createPulseScope(),
				connectors: [connector],
			}),
		);
		await connectPulse(a).synced;
		const b = track(
			await loadPulse(Note, a.id, {
				scope: createPulseScope(),
				connectors: [connector],
			}),
		);
		a.title = "From A";
		await eventually(() => expect(b.title).toBe("From A"));
		b.body.insert(0, ">");
		await eventually(() => expect(a.body.text).toBe(">Hello"));
		await eventually(() => expect(snapshotPulse(a)).toEqual(snapshotPulse(b)));
	});

	test("tabs on the same database see each other's updates", async () => {
		const open = profile();
		const tab1 = open(),
			tab2 = open(),
			unrelated = profile()();
		const a = track(
			createPulse(Note, note(), {
				scope: createPulseScope(),
				connectors: [tab1],
			}),
		);
		await connectPulse(a).synced;
		const b = track(
			await loadPulse(Note, a.id, {
				scope: createPulseScope(),
				connectors: [tab2],
			}),
		);
		const foreign: Uint8Array[] = [];
		const session = await unrelated.open({
			docId: a.id,
			signal: signal(),
			onMessage: (bytes) => foreign.push(bytes),
			onClose() {},
		});
		a.items.push({ value: 42 });
		await eventually(() =>
			expect(b.items.map((item) => item.value)).toEqual([1, 42]),
		);
		b.title = "From tab 2";
		await eventually(() => expect(a.title).toBe("From tab 2"));
		expect(foreign).toEqual([]);
		session.close();
	});

	test("frames are answered asynchronously, in order, and broadcast to other sessions", async () => {
		const open = profile();
		const connector = open(),
			tab = open();
		const docId = crypto.randomUUID();
		const received = {
			first: [] as Uint8Array[],
			second: [] as Uint8Array[],
			tab: [] as Uint8Array[],
		};
		const openSession = (c: IndexedDbConnector, into: Uint8Array[]) =>
			c.open({
				docId,
				signal: signal(),
				onMessage: (bytes) => into.push(bytes),
				onClose() {},
			});
		const first = await openSession(connector, received.first);
		const second = await openSession(connector, received.second);
		const other = await openSession(tab, received.tab);
		expect(first.protocolVersion).toBe(2);
		const row = (clock: number) => ({
			docId,
			sid: 70001,
			clock,
			span: 1,
			dependencies:
				clock === 1 ? [] : ([[70001, clock]] as Array<[number, number]>),
			operations: new Uint8Array([clock]),
		});
		const sends = [1, 2, 3].map((clock) =>
			first.send(
				encodeMessage({
					kind: 4,
					docId,
					requestId: clock,
					vv: [],
					rows: [row(clock)],
				}),
			),
		);
		expect(received.first).toEqual([]);
		await Promise.all(sends);
		expect(received.first.map((bytes) => decodeMessage(bytes))).toEqual(
			[1, 2, 3].map((clock) => ({
				kind: 5,
				docId,
				requestId: clock,
				vv: [[70001, clock + 1]],
			})),
		);
		for (const frames of [received.second, received.tab])
			await eventually(() =>
				expect(
					frames.map((bytes) => {
						const message = decodeMessage(bytes);
						return message.kind === 4 && message.rows[0]!.clock;
					}),
				).toEqual([1, 2, 3]),
			);
		// A duplicate is acknowledged but not broadcast again.
		await first.send(
			encodeMessage({ kind: 4, docId, requestId: 9, vv: [], rows: [row(1)] }),
		);
		await second.send(
			encodeMessage({ kind: 1, docId, requestId: 10, vv: [[70001, 2]] }),
		);
		const sync = decodeMessage(received.second.at(-1)!);
		expect(sync.kind === 2 && sync.rows.map((r) => r.clock)).toEqual([2, 3]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(received.tab).toHaveLength(3);

		// Sessions are pinned to their document; failures are protocol errors.
		await first.send(
			encodeMessage({ kind: 1, docId: "other", requestId: 11, vv: [] }),
		);
		const error = decodeMessage(received.first.at(-1)!);
		expect(error.kind === 6 && error.code).toBe("INVALID_MESSAGE");
		await first.send(
			encodeMessage({
				kind: 4,
				docId,
				requestId: 12,
				vv: [],
				rows: [{ ...row(1), operations: new Uint8Array([9]) }],
			}),
		);
		const conflict = decodeMessage(received.first.at(-1)!);
		expect(conflict.kind === 6 && conflict.code).toBe("CONFLICT");
		for (const session of [first, second, other]) session.close();
	});

	test("aborts, closes and reopening", async () => {
		const open = profile();
		const connector = open();
		const docId = crypto.randomUUID();
		const aborted = new AbortController();
		aborted.abort();
		const input = (
			signal: AbortSignal,
			closes: Array<Error | undefined> = [],
		) => ({
			docId,
			signal,
			onMessage() {},
			onClose: (error?: Error) => void closes.push(error),
		});
		await expect(connector.open(input(aborted.signal))).rejects.toMatchObject({
			code: "CLOSED",
		});
		// Aborting while the database is still opening.
		const pending = new AbortController();
		const opening = connector.open(input(pending.signal));
		pending.abort();
		await expect(opening).rejects.toMatchObject({ code: "CLOSED" });

		const live = new AbortController(),
			closes: Array<Error | undefined> = [];
		const session = await connector.open(input(live.signal, closes));
		live.abort();
		expect(closes).toHaveLength(1);
		expect(closes[0]).toMatchObject({ code: "CLOSED" });
		await expect(
			session.send(encodeMessage({ kind: 1, docId, requestId: 1, vv: [] })),
		).rejects.toMatchObject({ code: "CLOSED" });

		// A closed session can be replaced by a new one at any time.
		const sessions: ConnectorSession[] = [];
		for (let i = 0; i < 5; i++) {
			const next = await connector.open(input(signal(), closes));
			sessions.push(next);
			next.close();
			await expect(
				next.send(encodeMessage({ kind: 1, docId, requestId: 1, vv: [] })),
			).rejects.toMatchObject({ code: "CLOSED" });
		}
		expect(closes).toHaveLength(1);

		const open2: Array<Error | undefined> = [];
		await connector.open(input(signal(), open2));
		connector.close();
		expect(open2).toHaveLength(1);
		expect(open2[0]).toMatchObject({ code: "CLOSED" });
		await expect(connector.open(input(signal()))).rejects.toMatchObject({
			code: "CLOSED",
		});
		await expect(connector.store.vector(docId)).rejects.toMatchObject({
			code: "CLOSED",
		});
		const reopened = open();
		expect(await reopened.store.vector(docId)).toEqual([]);
	});

	test("a pulse reconnects many times and every session persists", async () => {
		const open = profile();
		const connector = open();
		const doc = track(
			createPulse(Note, note(), {
				scope: createPulseScope(),
				connectors: [connector],
			}),
		);
		for (let i = 0; i < 5; i++) {
			await connectPulse(doc).synced;
			doc.items.push({ value: i });
			await persisted(connector, doc);
			disconnectPulse(doc);
			doc.tags.push(`offline ${i}`);
		}
		await connectPulse(doc).synced;
		await persisted(connector, doc);
		const expected = snapshotPulse(doc);
		destroyPulse(doc);
		const loaded = track(
			await loadPulse(Note, expected.id, {
				scope: createPulseScope(),
				connectors: [open()],
			}),
		);
		expect(snapshotPulse(loaded)).toEqual(expected);
	});

	test("failures to open or a lost database are transient connection failures", async () => {
		const factory = new IDBFactory();
		let broken = true;
		const flaky = {
			open(name: string, version?: number) {
				if (broken) throw new Error("storage unavailable");
				return factory.open(name, version);
			},
		} as IDBFactory;
		const connector = createIndexedDbConnector({
			name: crypto.randomUUID(),
			indexedDB: flaky,
			IDBKeyRange,
		});
		cleanup.push(() => connector.close());
		const docId = crypto.randomUUID();
		const closes: Array<Error | undefined> = [];
		const input = {
			docId,
			signal: signal(),
			onMessage() {},
			onClose: (error?: Error) => void closes.push(error),
		};
		await expect(connector.open(input)).rejects.toMatchObject({
			code: "CONNECTION_FAILED",
		});
		broken = false;
		await connector.open(input);
		forceCloseDatabase((await connector.store.database()) as never);
		expect(closes).toHaveLength(1);
		expect(closes[0]).toMatchObject({ code: "CONNECTION_FAILED" });
		// The next open uses a fresh database connection.
		const frames: Uint8Array[] = [];
		const session = await connector.open({
			...input,
			onMessage: (bytes) => frames.push(bytes),
		});
		await session.send(encodeMessage({ kind: 1, docId, requestId: 1, vv: [] }));
		expect(decodeMessage(frames[0]!)).toMatchObject({ kind: 2, found: false });
		session.close();
	});

	test("a connection lost without a close event is dropped and reopened", async () => {
		const connector = profile()();
		const docId = crypto.randomUUID();
		const closes: Array<Error | undefined> = [];
		const input = {
			docId,
			signal: signal(),
			onMessage() {},
			onClose: (error?: Error) => void closes.push(error),
		};
		const session = await connector.open(input);
		// WebKit can kill the connection silently: transactions then throw.
		const dead = await connector.store.database();
		dead.transaction = () => {
			throw new DOMException("Connection lost", "InvalidStateError");
		};
		const request = encodeMessage({ kind: 1, docId, requestId: 1, vv: [] });
		await session.send(request);
		expect(closes).toHaveLength(1);
		expect(closes[0]).toMatchObject({ code: "CONNECTION_FAILED" });
		expect(await connector.store.database()).not.toBe(dead);

		const frames: Uint8Array[] = [];
		const next = await connector.open({
			...input,
			onMessage: (bytes) => frames.push(bytes),
		});
		await next.send(request);
		expect(decodeMessage(frames[0]!)).toMatchObject({ kind: 2, found: false });
		next.close();
	});

	test("connected pulses survive a lost database and stop for good on close()", async () => {
		const open = profile();
		const connector = open();
		const reconnect = {
			initialDelayMs: 2,
			maxDelayMs: 10,
			factor: 2,
			jitter: 0,
		};
		const errors: Error[] = [];
		const pulse = track(
			createPulse(
				Task,
				{ title: "Persist", done: false },
				{
					scope: createPulseScope(),
					connectors: [connector],
					reconnect,
					onError: (error) => errors.push(error),
				},
			),
		);
		await connectPulse(pulse).synced;
		forceCloseDatabase((await connector.store.database()) as never);
		pulse.title = "Written while the database was lost";
		await eventually(() => expect(getPulseMeta(pulse).status).toBe("synced"));
		await persisted(connector, pulse);
		expect(errors.map((error) => (error as { code?: string }).code)).toEqual([
			"CONNECTION_FAILED",
		]);

		connector.close();
		await eventually(() => expect(getPulseMeta(pulse).status).toBe("error"));
		const connection = getPulseMeta(pulse).connections[0]!;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(connection.status).toBe("error");
		expect(connection.attempt).toBe(0);
		const reloaded = track(
			await loadPulse(Task, pulse.id, {
				scope: createPulseScope(),
				connectors: [open()],
			}),
		);
		expect(reloaded.title).toBe("Written while the database was lost");
	});

	test("forget and clear wipe local documents", async () => {
		const open = profile();
		const connector = open();
		const scope = createPulseScope();
		const a = createPulse(Note, note(), { scope, connectors: [connector] });
		const b = createPulse(Note, note(), { scope, connectors: [connector] });
		await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
		const [first, second] = [a.id, b.id];
		destroyPulse(a);
		destroyPulse(b);
		await connector.forget(first);
		await expect(
			loadPulse(Note, first, {
				scope: createPulseScope(),
				connectors: [connector],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((await connector.store.vector(second)).length).toBe(1);
		await connector.clear();
		expect(await connector.store.vector(second)).toEqual([]);
	});
});
