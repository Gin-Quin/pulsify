import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { object } from "@gin-quin/codec";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	disconnectPulse,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	snapshotPulse,
	createMemoryConnector,
	PulseError,
	PulseRelay,
	type Connector,
} from "pulsify-core";
import { relayStoreMessage, encodeRecoveryFrames } from "pulsify-core/protocol";
import { SqlitePatchStore } from "pulsify-core/storage";
import {
	createIndexedDbConnector,
	IndexedDbPatchStore,
} from "../source/index.js";

const Note = definePulse(
	"DeletedNote",
	object({ title: "string" }),
).materialize();

test("offline work remains recoverable after authoritative deletion, including after reopening", async () => {
	const db = new Database(":memory:"),
		server = new SqlitePatchStore(db);
	const options = {
		name: crypto.randomUUID(),
		indexedDB: new IDBFactory(),
		IDBKeyRange,
	};
	const local = createIndexedDbConnector(options);
	let online = true,
		uploadsAfterDelete = 0;
	const remote: Connector = {
		kind: "remote",
		authoritativeDeletions: true,
		async open({ docId, onMessage }) {
			if (!online) throw new PulseError("CONNECTION_FAILED", "Offline");
			return {
				close() {},
				async send(frame) {
					const result = await relayStoreMessage(server, frame, { docId });
					if (result.broadcast && (await server.isDeleted(docId)))
						uploadsAfterDelete++;
					for (const response of result.responses) onMessage(response);
				},
			};
		},
	};
	const pulse = createPulse(
		Note,
		{ id: "root/note", title: "Original" },
		{
			scope: createPulseScope(),
			connectors: [local, remote],
			reconnect: false,
		},
	);
	try {
		await connectPulse(pulse).synced;
		disconnectPulse(pulse);
		online = false;
		pulse.title = "Unsent work";
		await server.deleteDocuments("root/note");
		online = true;
		await expect(connectPulse(pulse).synced).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await getPulseMeta(pulse).deletion;
		expect(getPulseMeta(pulse).deleted).toBe(true);
		expect(snapshotPulse(pulse).title).toBe("Unsent work");
		expect(() => {
			pulse.title = "Cannot edit a deleted document";
		}).toThrow();
		await expect(
			loadPulse(Note, pulse.id, { scope: getPulseMeta(pulse).options.scope }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(uploadsAfterDelete).toBe(0);
		local.close();
		const reopened = createIndexedDbConnector(options);
		try {
			await expect(
				loadPulse(Note, pulse.id, {
					scope: createPulseScope(),
					connectors: [reopened],
					reconnect: false,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			const rows = await reopened.store.recoverRows(pulse.id);
			expect(rows.length).toBeGreaterThan(0);
			// Recovery is an explicit isolated replica, never an undelete/upload.
			const relay = new PulseRelay(),
				peer = relay.open(() => {}, { docId: pulse.id });
			for (const frame of encodeRecoveryFrames(rows)) peer.receive(frame);
			peer.close();
			const copy = await loadPulse(Note, pulse.id, {
				scope: createPulseScope(),
				connectors: [createMemoryConnector(relay)],
			});
			expect(copy.title).toBe("Unsent work");
			destroyPulse(copy);
		} finally {
			reopened.close();
		}
	} finally {
		destroyPulse(pulse);
		local.close();
		db.close();
	}
});

test("IndexedDB retires same-tab and other-tab sessions even when recovery fails", async () => {
	const original = {
		docId: "r/a",
		sid: 70001,
		clock: 1,
		span: 1,
		dependencies: [],
		operations: Uint8Array.of(99),
	};
	for (const invalid of [
		{ ...original, operations: Uint8Array.of(98) },
		{ ...original, docId: "outside" },
		{ ...original, operations: new Uint8Array() },
	]) {
		const options = {
			name: crypto.randomUUID(),
			indexedDB: new IDBFactory(),
			IDBKeyRange,
		};
		const a = createIndexedDbConnector(options),
			b = createIndexedDbConnector(options);
		const closed: string[] = [];
		try {
			await a.store.append([original]);
			for (const [label, connector] of [
				["a", a],
				["b", b],
			] as const)
				await connector.open({
					docId: "r/a",
					signal: new AbortController().signal,
					onMessage() {},
					onClose(error) {
						if ((error as PulseError).code === "NOT_FOUND") closed.push(label);
					},
				});
			await expect(a.markDeleted!("r/a", [invalid])).rejects.toBeDefined();
			for (let tries = 0; tries < 100 && closed.length < 2; tries++)
				await Bun.sleep(2);
			expect(closed.sort()).toEqual(["a", "b"]);
			expect(await a.store.recoverRows("r/a")).toEqual([original]);
			await expect(b.store.append([original])).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		} finally {
			a.close();
			b.close();
		}
	}
});

test("a normally absent document does not become permanently deleted", async () => {
	const local = createIndexedDbConnector({
		name: crypto.randomUUID(),
		indexedDB: new IDBFactory(),
		IDBKeyRange,
	});
	try {
		await expect(
			loadPulse(Note, "missing", {
				scope: createPulseScope(),
				connectors: [local],
				reconnect: false,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await local.store.isDeleted("missing")).toBe(false);
	} finally {
		local.close();
	}
});

test("cached data stays available offline without waiting for a network prefetch", async () => {
	const local = createIndexedDbConnector({
		name: crypto.randomUUID(),
		indexedDB: new IDBFactory(),
		IDBKeyRange,
	});
	let prefetches = 0;
	const remote: Connector = {
		kind: "remote",
		async prefetch() {
			prefetches++;
			throw new PulseError("TIMEOUT", "Offline");
		},
		async open() {
			throw new PulseError("CONNECTION_FAILED", "Offline");
		},
	};
	const original = createPulse(
		Note,
		{ id: "r/cached", title: "Available offline" },
		{ scope: createPulseScope(), connectors: [local] },
	);
	try {
		await connectPulse(original).synced;
		const id = original.id;
		destroyPulse(original);
		const loaded = await loadPulse(Note, id, {
			scope: createPulseScope(),
			connectors: [local, remote],
			reconnect: false,
		});
		expect(loaded.title).toBe("Available offline");
		expect(prefetches).toBe(0);
		destroyPulse(loaded);
	} finally {
		destroyPulse(original);
		local.close();
	}
});

test("an authoritative prefetch deletion retires an already loaded disconnected pulse", async () => {
	const scope = createPulseScope();
	const remote: Connector = {
		kind: "remote",
		authoritativeDeletions: true,
		async prefetch() {
			throw new PulseError("NOT_FOUND", "Deleted");
		},
		async open() {
			throw new Error("Deletion must be handled before reopening");
		},
	};
	const pulse = createPulse(
		Note,
		{ id: "r/cached", title: "Recover me" },
		{ scope, connectors: [remote] },
	);
	try {
		await expect(
			loadPulse(Note, pulse.id, { scope, connectors: [remote] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(getPulseMeta(pulse).deleted).toBe(true);
		expect(snapshotPulse(pulse).title).toBe("Recover me");
		expect(() => {
			pulse.title = "No";
		}).toThrow();
	} finally {
		destroyPulse(pulse);
	}
});

test("two IndexedDB handles serialize deletion against appends and retain the marker after clearing rows", async () => {
	const options = {
		name: crypto.randomUUID(),
		indexedDB: new IDBFactory(),
		IDBKeyRange,
	};
	const a = new IndexedDbPatchStore(options),
		b = new IndexedDbPatchStore(options);
	const row = {
		docId: "root/a/unknown",
		sid: 70001,
		clock: 1,
		span: 1,
		dependencies: [],
		operations: Uint8Array.of(99),
	};
	try {
		await Promise.allSettled([a.deleteDocuments("root/a"), b.append([row])]);
		expect(await b.isDeleted(row.docId)).toBe(true);
		expect(await b.recoverRows(row.docId)).toEqual([]);
		await b.clear();
		await expect(a.append([row])).rejects.toMatchObject({ code: "NOT_FOUND" });
	} finally {
		a.close();
		b.close();
	}
});
