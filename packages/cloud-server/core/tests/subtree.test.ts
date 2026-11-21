import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	CloudRoot,
	SqliteCloudStorage,
	type CloudPeer,
} from "../source/index.js";
import {
	decodeMessage,
	encodeMessage,
	type PulseMessage,
} from "pulsify-core/protocol";

async function fixture(autoAck = true) {
	const db = new Database(":memory:"),
		storage = new SqliteCloudStorage(db);
	await storage.putGrant({ subject: "alice", prefix: "r", role: "owner" });
	for (const docId of ["r", "r/a", "r/a/child", "r/ab", "r/b"])
		await storage.patches.append([
			{
				docId,
				sid: 70001,
				clock: 1,
				span: 1,
				dependencies: [],
				operations: Uint8Array.of(99),
			},
		]);
	const frames: PulseMessage[] = [],
		texts: any[] = [];
	const peer: CloudPeer = {
		id: "socket",
		subject: "alice",
		envelope: 2,
		presence: false,
		subscriptions: new Map(),
		keepSubscriptions: () => true,
		usePresence() {},
		close() {},
		send(data) {
			if (typeof data === "string") {
				const message = JSON.parse(data);
				texts.push(message);
				if (autoAck && message.type === "fetch-batch")
					queueMicrotask(
						() =>
							void root.receive(
								peer,
								JSON.stringify({
									type: "fetch-ack",
									requestId: message.requestId,
									batch: message.batch,
								}),
							),
					);
			} else frames.push(decodeMessage(data));
		},
	};
	const root = new CloudRoot("r", storage, {
		get: () => peer,
		all: () => [peer],
	});
	let requestId = Number.MAX_SAFE_INTEGER;
	return {
		db,
		storage,
		root,
		peer,
		frames,
		texts,
		async fetch(docId: string, descendants: boolean, vectors: unknown[] = []) {
			frames.length = texts.length = 0;
			await root.receive(
				peer,
				JSON.stringify({
					type: "fetch",
					docId,
					descendants,
					vectors,
					requestId: requestId--,
				}),
			);
		},
	};
}

test("one request fetches exactly one document or its ID subtree, never parents or siblings", async () => {
	const f = await fixture();
	try {
		for (const [id, descendants, expected] of [
			["r", false, ["r"]],
			["r", true, ["r", "r/a", "r/a/child", "r/ab", "r/b"]],
			["r/a", false, ["r/a"]],
			["r/a", true, ["r/a", "r/a/child"]],
		] as const) {
			await f.fetch(id, descendants);
			expect(f.frames.map((frame) => frame.docId)).toEqual([...expected]);
			expect(
				f.frames.every((frame) => frame.kind === 2 && frame.rows.length === 1),
			).toBe(true);
			expect(f.texts.at(-1)).toMatchObject({ type: "fetched", complete: true });
		}
		await f.fetch("r/a", true, [["r/a", [[70001, 2]]]]);
		expect(f.frames[0]).toMatchObject({ kind: 2, rows: [] });
		expect(f.frames[1]).toMatchObject({
			kind: 2,
			docId: "r/a/child",
			rows: [{ docId: "r/a/child" }],
		});
	} finally {
		f.db.close();
	}
});

test("deletion excludes a subtree, rejects stale uploads and never-seen offline descendants", async () => {
	const f = await fixture();
	try {
		await f.storage.patches.deleteDocuments("r/a");
		await f.fetch("r", true);
		expect(f.frames.map((frame) => frame.docId)).toEqual(["r", "r/ab", "r/b"]);
		await f.fetch("r/a", true);
		expect(f.frames).toMatchObject([{ kind: 6, code: "NOT_FOUND" }]);
		await f.root.receive(
			f.peer,
			encodeMessage({ kind: 1, docId: "r/a/offline", requestId: 1, vv: [] }),
		);
		await f.root.receive(
			f.peer,
			encodeMessage({
				kind: 3,
				docId: "r/a/offline",
				requestId: 2,
				vv: [],
				rows: [
					{
						docId: "r/a/offline",
						sid: 70001,
						clock: 1,
						span: 1,
						dependencies: [],
						operations: Uint8Array.of(99),
					},
				],
			}),
		);
		expect(f.frames.slice(-2)).toMatchObject([
			{ kind: 6, code: "NOT_FOUND" },
			{ kind: 6, code: "NOT_FOUND" },
		]);
		expect(await f.storage.patches.recoverRows("r/a/offline")).toEqual([]);
		await expect(f.storage.patches.vector("r/a/offline")).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		);
	} finally {
		f.db.close();
	}
});

test("connecting to a tombstoned document creates no dead subscription", async () => {
	const f = await fixture();
	try {
		const kept: string[][] = [];
		f.peer.keepSubscriptions = (subscriptions) => {
			kept.push([...subscriptions.keys()]);
			return true;
		};
		await f.storage.patches.deleteDocuments("r/a");
		await f.root.receive(
			f.peer,
			encodeMessage({ kind: 1, docId: "r/a", requestId: 1, vv: [] }),
		);
		expect(f.frames).toMatchObject([{ kind: 6, code: "NOT_FOUND" }]);
		expect(kept.flat()).not.toContain("r/a");
		expect(
			f.db.query("SELECT * FROM pulsify_cloud_subscriptions").all(),
		).toEqual([]);
	} finally {
		f.db.close();
	}
});

test("one fetch streams every page beyond 256 documents without creating subscriptions", async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 520; i++)
			await f.storage.patches.append([
				{
					docId: `r/many/${i}`,
					sid: 70001,
					clock: 1,
					span: 1,
					dependencies: [],
					operations: Uint8Array.of(99),
				},
			]);
		await f.fetch("r", true);
		expect(f.frames.length).toBe(525);
		expect(new Set(f.frames.map((frame) => frame.docId)).size).toBe(525);
		expect(
			f.texts.filter((message) => message.type === "fetch-batch").length,
		).toBeGreaterThan(1);
		expect(f.texts.at(-1)).toMatchObject({ complete: true });
		expect(
			f.db.query("SELECT * FROM pulsify_cloud_subscriptions").all(),
		).toEqual([]);
	} finally {
		f.db.close();
	}
});

test("one document larger than 8 MiB is delivered in full within one fetch", async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 12; i++)
			await f.storage.patches.append([
				{
					docId: "r/large",
					sid: 70001,
					clock: i + 1,
					span: 1,
					dependencies: i ? [[70001, i + 1]] : [],
					operations: new Uint8Array(800 * 1024).fill(i + 1),
				},
			]);
		await f.fetch("r/large", false);
		const rows = f.frames.flatMap((frame) =>
			frame.kind === 2 ? frame.rows : [],
		);
		expect(rows.map((row) => row.clock)).toEqual(
			Array.from({ length: 12 }, (_, i) => i + 1),
		);
		expect(rows.reduce((sum, row) => sum + row.operations.length, 0)).toBe(
			12 * 800 * 1024,
		);
		expect(f.frames.every((frame) => frame.docId === "r/large")).toBe(true);
		expect(f.texts.at(-1)).toMatchObject({ type: "fetched", complete: true });
	} finally {
		f.db.close();
	}
});

async function stalledFetch() {
	const f = await fixture(false);
	for (let i = 0; i < 65; i++)
		await f.storage.patches.append([
			{
				docId: `r/many/${String(i).padStart(3, "0")}`,
				sid: 70001,
				clock: 1,
				span: 1,
				dependencies: [],
				operations: Uint8Array.of(99),
			},
		]);
	const finished = f.fetch("r", true);
	while (!f.texts.some((message) => message.type === "fetch-batch"))
		await Bun.sleep(1);
	const batch = f.texts.find((message) => message.type === "fetch-batch");
	return { ...f, finished, batch };
}

test("a paused fetch frees the root queue and excludes descendants deleted between batches", async () => {
	const f = await stalledFetch();
	try {
		expect(f.frames.length).toBe(64);
		expect(await f.root.roleOf("alice", "r")).toBe("owner");
		const deleted = await f.root.handleRequest(
			"documents",
			new Request("https://test/documents?docId=r/many/064", {
				method: "DELETE",
			}),
			{ kind: "admin" },
		);
		expect(deleted.status).toBe(200);
		await f.root.receive(
			f.peer,
			JSON.stringify({ ...f.batch, type: "fetch-ack" }),
		);
		await f.finished;
		expect(f.frames.some((frame) => frame.docId === "r/many/064")).toBe(false);
		expect(f.texts.at(-1)).toMatchObject({ complete: true });
		await expect(
			f.storage.patches.append([
				{
					docId: "r/many/064/offline",
					sid: 70001,
					clock: 1,
					span: 1,
					dependencies: [],
					operations: Uint8Array.of(99),
				},
			]),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	} finally {
		await f.root.disconnect(f.peer);
		await f.finished;
		f.db.close();
	}
});

test("deleting the requested root terminates a paused fetch immediately", async () => {
	const f = await stalledFetch();
	try {
		const result = await f.root.handleRequest(
			"documents",
			new Request("https://test/documents?docId=r", { method: "DELETE" }),
			{ kind: "admin" },
		);
		expect(result.status).toBe(200);
		await f.finished;
		expect(f.frames.at(-1)).toMatchObject({
			kind: 6,
			docId: "r",
			code: "NOT_FOUND",
		});
		expect(f.texts.some((message) => message.type === "fetched")).toBe(false);
	} finally {
		await f.root.disconnect(f.peer);
		await f.finished;
		f.db.close();
	}
});

test("revoking access terminates a paused fetch before another data frame", async () => {
	const f = await stalledFetch();
	try {
		const result = await f.root.handleRequest(
			"grants",
			new Request("https://test/grants?subject=alice&prefix=r", {
				method: "DELETE",
			}),
			{ kind: "admin" },
		);
		expect(result.status).toBe(200);
		await f.finished;
		expect(f.frames.length).toBe(65);
		expect(f.frames.at(-1)).toMatchObject({ kind: 6, code: "FORBIDDEN" });
	} finally {
		await f.root.disconnect(f.peer);
		await f.finished;
		f.db.close();
	}
});

test("cancelling or disconnecting releases a paused fetch without sending more data", async () => {
	for (const disconnect of [false, true]) {
		const f = await stalledFetch();
		try {
			if (disconnect) await f.root.disconnect(f.peer);
			else
				await f.root.receive(
					f.peer,
					JSON.stringify({
						type: "cancel-fetch",
						requestId: f.batch.requestId,
					}),
				);
			await f.finished;
			expect(f.frames.length).toBe(64);
			expect(f.texts.some((message) => message.type === "fetched")).toBe(false);
		} finally {
			await f.root.disconnect(f.peer);
			await f.finished;
			f.db.close();
		}
	}
});

test("a failed storage deletion does not notify clients that live data was deleted", async () => {
	const f = await fixture();
	try {
		await f.root.receive(
			f.peer,
			encodeMessage({ kind: 1, docId: "r/a", requestId: 1, vv: [] }),
		);
		f.frames.length = 0;
		f.db.exec(
			"CREATE TRIGGER fail_delete BEFORE DELETE ON pulsify_op_rows BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
		);
		const result = await f.root.handleRequest(
			"documents",
			new Request("https://test/documents?docId=r/a", { method: "DELETE" }),
			{ kind: "admin" },
		);
		expect(result.status).toBe(503);
		expect(f.frames).toEqual([]);
		expect(await f.storage.isDeleted("r/a")).toBe(false);
		expect(await f.storage.patches.vector("r/a")).toEqual([[70001, 2]]);
	} finally {
		f.db.close();
	}
});

test("watch pushes live descendant updates to another peer, enforces grants and stops on unwatch", async () => {
	const db = new Database(":memory:");
	const storage = new SqliteCloudStorage(db);
	try {
		await storage.putGrant({ subject: "alice", prefix: "r", role: "owner" });
		await storage.putGrant({ subject: "bob", prefix: "r", role: "reader" });
		const makePeer = (id: string, subject: string) => {
			const frames: PulseMessage[] = [];
			const peer: CloudPeer = {
				id,
				subject,
				envelope: 2,
				presence: false,
				subscriptions: new Map(),
				keepSubscriptions: () => true,
				watches: new Set(),
				keepWatches: () => true,
				usePresence() {},
				close() {},
				send(data) {
					if (typeof data !== "string") frames.push(decodeMessage(data));
				},
			};
			return { peer, frames };
		};
		const a = makePeer("a", "alice");
		const b = makePeer("b", "bob");
		const peers = new Map([
			[a.peer.id, a.peer],
			[b.peer.id, b.peer],
		]);
		const root = new CloudRoot("r", storage, {
			get: (id) => peers.get(id),
			all: () => peers.values(),
		});

		await root.receive(b.peer, JSON.stringify({ type: "watch", docId: "r" }));
		await root.receive(
			a.peer,
			encodeMessage({ kind: 1, docId: "r/child-1", requestId: 1, vv: [] }),
		);
		await root.receive(
			a.peer,
			encodeMessage({
				kind: 3,
				docId: "r/child-1",
				requestId: 2,
				vv: [],
				rows: [
					{
						docId: "r/child-1",
						sid: 70001,
						clock: 1,
						span: 1,
						dependencies: [],
						operations: Uint8Array.of(42),
					},
				],
			}),
		);
		expect(b.frames).toMatchObject([
			{ kind: 4, docId: "r/child-1", requestId: 0, rows: [{ clock: 1 }] },
		]);

		// Subscribing to r/child-1 as well must not produce duplicate broadcasts.
		b.frames.length = 0;
		await root.receive(
			b.peer,
			encodeMessage({ kind: 1, docId: "r/child-1", requestId: 1, vv: [] }),
		);
		b.frames.length = 0;
		await root.receive(
			a.peer,
			encodeMessage({
				kind: 3,
				docId: "r/child-1",
				requestId: 3,
				vv: [],
				rows: [
					{
						docId: "r/child-1",
						sid: 70001,
						clock: 2,
						span: 1,
						dependencies: [[70001, 2]],
						operations: Uint8Array.of(43),
					},
				],
			}),
		);
		expect(b.frames).toHaveLength(1);

		// Unwatching stops pushes for new descendants.
		b.frames.length = 0;
		await root.receive(b.peer, JSON.stringify({ type: "unwatch", docId: "r" }));
		await root.receive(
			a.peer,
			encodeMessage({ kind: 1, docId: "r/child-2", requestId: 4, vv: [] }),
		);
		await root.receive(
			a.peer,
			encodeMessage({
				kind: 3,
				docId: "r/child-2",
				requestId: 5,
				vv: [],
				rows: [
					{
						docId: "r/child-2",
						sid: 70001,
						clock: 1,
						span: 1,
						dependencies: [],
						operations: Uint8Array.of(44),
					},
				],
			}),
		);
		expect(b.frames).toEqual([]);

		// Revoking access removes active watches and stops pushes.
		await root.receive(b.peer, JSON.stringify({ type: "watch", docId: "r" }));
		await root.handleRequest(
			"grants",
			new Request("https://test/grants?subject=bob&prefix=r", {
				method: "DELETE",
			}),
			{ kind: "admin" },
		);
		b.frames.length = 0;
		await root.receive(
			a.peer,
			encodeMessage({ kind: 1, docId: "r/child-3", requestId: 6, vv: [] }),
		);
		await root.receive(
			a.peer,
			encodeMessage({
				kind: 3,
				docId: "r/child-3",
				requestId: 7,
				vv: [],
				rows: [
					{
						docId: "r/child-3",
						sid: 70001,
						clock: 1,
						span: 1,
						dependencies: [],
						operations: Uint8Array.of(45),
					},
				],
			}),
		);
		expect(b.frames).toEqual([]);
	} finally {
		db.close();
	}
});
