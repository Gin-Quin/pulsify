import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	createCloudConnector,
	CLOUD_SUBPROTOCOLS,
	welcomeMessage,
} from "pulsify-cloud";
import { type StoredPatchRow } from "pulsify-core/storage";
import { encodeMessage } from "pulsify-core/protocol";
import {
	CloudRoot,
	SqliteCloudStorage,
	type CloudPeer,
} from "../source/index.js";

/** Real WebSockets, with direct access to storage for large-transfer fixtures. */
function host(deliveryDelayMs = 0) {
	const db = new Database(":memory:"),
		storage = new SqliteCloudStorage(db);
	const peers = new Map<string, CloudPeer>();
	const root = new CloudRoot("r", storage, {
		get: (id) => peers.get(id),
		all: () => peers.values(),
	});
	const controls: any[] = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let onBatch: ((message: any) => void) | undefined;
	let fetchError: string | undefined;
	const server = Bun.serve<{ id: string }>({
		port: 0,
		fetch(request, server) {
			return server.upgrade(request, {
				data: { id: crypto.randomUUID() },
				headers: { "Sec-WebSocket-Protocol": CLOUD_SUBPROTOCOLS[2] },
			})
				? undefined
				: new Response(null, { status: 400 });
		},
		websocket: {
			open(socket) {
				let availableAt = 0;
				const peer: CloudPeer = {
					id: socket.data.id,
					subject: "alice",
					envelope: 2,
					presence: false,
					subscriptions: new Map(),
					keepSubscriptions: () => true,
					usePresence() {},
					close: (code, reason) => socket.close(code, reason),
					send(data) {
						if (typeof data === "string") {
							const message = JSON.parse(data);
							if (message.type === "fetch-batch") onBatch?.(message);
						}
						if (!deliveryDelayMs) {
							socket.send(data);
							return;
						}
						availableAt = Math.max(availableAt, Date.now()) + deliveryDelayMs;
						const timer = setTimeout(() => {
							timers.delete(timer);
							socket.send(data);
						}, availableAt - Date.now());
						timers.add(timer);
					},
				};
				peers.set(peer.id, peer);
				peer.send(
					welcomeMessage(
						{ backend: "test", id: "streaming" },
						{ subtrees: true },
					),
				);
			},
			message(socket, data) {
				const peer = peers.get(socket.data.id);
				if (typeof data === "string") {
					const control = JSON.parse(data);
					controls.push(control);
					if (control.type === "fetch" && fetchError) {
						peer?.send(
							encodeMessage({
								kind: 6,
								docId: control.docId,
								requestId: control.requestId,
								code: fetchError,
								message: "Future server error",
							}),
						);
						return;
					}
				}
				if (peer)
					void root.receive(
						peer,
						typeof data === "string" ? data : new Uint8Array(data),
					);
			},
			close(socket) {
				const peer = peers.get(socket.data.id);
				peers.delete(socket.data.id);
				if (peer) void root.disconnect(peer);
			},
		},
	});
	const cloud = createCloudConnector({
		url: `http://127.0.0.1:${server.port}`,
		token: "test",
		heartbeat: false,
		lingerMs: 1,
	});
	return {
		storage,
		root,
		cloud,
		controls,
		set onBatch(callback: typeof onBatch) {
			onBatch = callback;
		},
		set fetchError(code: string | undefined) {
			fetchError = code;
		},
		async close() {
			cloud.close();
			for (const timer of timers) clearTimeout(timer);
			for (const peer of peers.values()) await root.disconnect(peer);
			server.stop(true);
			db.close();
		},
	};
}

test("an unknown fetch error is normalized to a retryable connection failure", async () => {
	const f = host();
	try {
		f.fetchError = "FUTURE_ERROR";
		await expect(
			f.cloud.prefetch!("r", { descendants: true, vectors: [] }),
		).rejects.toMatchObject({
			code: "CONNECTION_FAILED",
			message: "FUTURE_ERROR: Future server error",
		});
	} finally {
		await f.close();
	}
});

function row(docId: string, clock = 1, bytes = 1): StoredPatchRow {
	return {
		docId,
		sid: 70001,
		clock,
		span: 1,
		dependencies: clock === 1 ? [] : [[70001, clock]],
		operations: new Uint8Array(bytes).fill(99),
	};
}
async function seed(f: ReturnType<typeof host>, count = 0) {
	await f.storage.putGrant({ subject: "alice", prefix: "r", role: "owner" });
	await f.storage.patches.append([row("r")]);
	for (let i = 0; i < count; i++)
		await f.storage.patches.append([row(`r/${String(i).padStart(4, "0")}`)]);
}

test("the cloud client receives every document using one fetch, even with excess vector hints", async () => {
	const f = host();
	try {
		await seed(f, 520);
		const result = await f.cloud.prefetch!("r", {
			descendants: true,
			vectors: Array.from({ length: 5000 }, (_, i) => [
				`r/unknown/${i}`,
				[[70001, 2]],
			]),
		});
		expect(result?.complete).toBe(true);
		expect(result?.documents.size).toBe(521);
		expect(
			f.controls.filter((message) => message.type === "fetch"),
		).toHaveLength(1);
		expect(
			f.controls.filter((message) => message.type === "fetch-ack").length,
		).toBeGreaterThan(1);
		expect(
			JSON.stringify(f.controls.find((message) => message.type === "fetch"))
				.length,
		).toBeLessThanOrEqual(64 * 1024);
	} finally {
		await f.close();
	}
});

test("the cloud client accepts more than 8 MiB and keeps a progressing transfer alive", async () => {
	const f = host(60);
	try {
		await seed(f);
		for (let clock = 1; clock <= 12; clock++)
			await f.storage.patches.append([row("r/large", clock, 800 * 1024)]);
		const started = Date.now();
		const result = await f.cloud.prefetch!("r/large", {
			descendants: false,
			vectors: [],
			timeoutMs: 200,
		});
		expect(Date.now() - started).toBeGreaterThan(200);
		expect(
			result?.documents
				.get("r/large")
				?.reduce((sum, row) => sum + row.operations.length, 0),
		).toBe(12 * 800 * 1024);
		expect(result?.complete).toBe(true);
		expect(
			f.controls.filter((message) => message.type === "fetch"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("a child deleted halfway through streaming is discarded without deleting the fetched parent", async () => {
	const f = host();
	try {
		await seed(f);
		for (let clock = 1; clock <= 6; clock++)
			await f.storage.patches.append([row("r/child", clock, 800 * 1024)]);
		let deletion: Promise<Response> | undefined;
		f.onBatch = (message) => {
			if (message.batch === 2)
				deletion = f.root.handleRequest(
					"documents",
					new Request("https://test/documents?docId=r/child", {
						method: "DELETE",
					}),
					{ kind: "admin" },
				);
		};
		const result = await f.cloud.prefetch!("r", {
			descendants: true,
			vectors: [],
		});
		expect((await deletion)?.status).toBe(200);
		expect([...result!.documents.keys()]).toEqual(["r"]);
		expect(result?.complete).toBe(true);
		expect(await f.storage.isDeleted("r")).toBe(false);
		expect(await f.storage.isDeleted("r/child")).toBe(true);
	} finally {
		await f.close();
	}
});

test("aborting a streaming fetch cancels server work without closing the shared socket", async () => {
	const f = host();
	try {
		await seed(f, 200);
		const controller = new AbortController();
		f.onBatch = () => controller.abort();
		await expect(
			f.cloud.prefetch!("r", {
				descendants: true,
				vectors: [],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ code: "CLOSED" });
		f.onBatch = undefined;
		const next = await f.cloud.prefetch!("r", {
			descendants: false,
			vectors: [],
		});
		expect(next?.documents.size).toBe(1);
		expect(f.controls.some((message) => message.type === "cancel-fetch")).toBe(
			true,
		);
	} finally {
		await f.close();
	}
});
