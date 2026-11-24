import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	loadPulse,
	PulseRelay,
	PulseError,
	createMemoryConnector,
	relayStoreMessage,
	streamStoreMessage,
	encodeBroadcast,
	encodeBroadcastFrames,
	encodeMessage,
	decodeMessage,
	definePulse,
	exportPulseUpdates,
	applyPulseUpdates,
	getPulseMeta,
	snapshotPulse,
	versioned,
	type Connector,
} from "../source/index";
import { object } from "@gin-quin/codec";
import { MAX_FRAME_BYTES } from "../source/protocol/limits";
import { createRuntime } from "../source/pulses/PulseRuntime";
import { defaultPulseOptions } from "../source/pulses/PulseOptions";
import { SqlitePatchStore } from "../source/storage/sqlite";
import { Document, data, eventually } from "./helpers";

function storeConnector(
	store: SqlitePatchStore,
	readOnly: boolean,
	peers: Set<(bytes: Uint8Array) => void>,
): Connector {
	return {
		kind: "remote",
		async open({ docId, onMessage }) {
			const deliver = (bytes: Uint8Array) => onMessage(bytes);
			peers.add(deliver);
			return {
				protocolVersion: 2,
				close() {
					peers.delete(deliver);
				},
				async send(bytes) {
					const result = await relayStoreMessage(store, bytes, {
						docId,
						readOnly,
						protocolVersion: 2,
					});
					for (const frame of result.responses) deliver(frame);
					if (result.broadcast)
						for (const peer of peers)
							if (peer !== deliver)
								peer(encodeBroadcast(docId, result.broadcast, 2));
				},
			};
		},
	};
}

describe("store relay", () => {
	test("editors persist and broadcast; readers download but cannot write", async () => {
		const store = new SqlitePatchStore(new Database(":memory:"));
		const peers = new Set<(bytes: Uint8Array) => void>();
		const editor = createPulse(Document, data("doc"), {
			scope: createPulseScope(),
			connectors: [storeConnector(store, false, peers)],
		});
		await connectPulse(editor).synced;
		expect((await store.vector("doc")).length).toBe(1);

		const errors: Error[] = [];
		const reader = await loadPulse(Document, "doc", {
			scope: createPulseScope(),
			connectors: [storeConnector(store, true, peers)],
			waitFor: "all",
			onError: (error) => errors.push(error),
		});
		expect(reader.title).toBe("Hello 🌍");
		editor.title = "Updated";
		await eventually(() => expect(reader.title).toBe("Updated"));

		reader.title = "Illegal";
		await eventually(() => expect(errors.length).toBeGreaterThan(0));
		expect((errors[0] as PulseError).code).toBe("FORBIDDEN");
		expect((await store.missing("doc", [])).length).toBe(2);
	});

	test("sessions are pinned to one document", async () => {
		const store = new SqlitePatchStore(new Database(":memory:"));
		const bytes = new PulseRelay();
		void bytes;
		const { encodeMessage } = await import("../source/index");
		const result = await relayStoreMessage(
			store,
			encodeMessage({ kind: 1, docId: "other", requestId: 1, vv: [] }),
			{ docId: "doc" },
		);
		const reply = decodeMessage(result.responses[0]!);
		expect(reply.kind).toBe(6);
		expect(reply.kind === 6 && reply.code).toBe("INVALID_MESSAGE");
	});

	test("in-memory relay honors read-only sessions", () => {
		const relay = new PulseRelay();
		const frames: Uint8Array[] = [];
		const peer = relay.open((bytes) => frames.push(bytes), {
			readOnly: true,
			docId: "doc",
		});
		const { encodeMessage } = require("../source/index");
		peer.receive(
			encodeMessage({ kind: 4, docId: "doc", requestId: 1, vv: [], rows: [] }),
		);
		const reply = decodeMessage(frames[0]!);
		expect(reply.kind === 6 && reply.code).toBe("FORBIDDEN");
		void createMemoryConnector;
	});

	test("S6: streamStoreMessage pages incrementally and sets complete only on the last frame", async () => {
		const store = new SqlitePatchStore(new Database(":memory:"));
		const docId = "streamed";
		const payload = new Uint8Array(400 * 1024).fill(7);
		payload[0] = 3;
		for (let i = 1; i <= 12; i++) {
			await store.append([
				{
					docId,
					sid: 70001,
					clock: i,
					span: 1,
					dependencies: i === 1 ? [] : [[70001, i]],
					operations: payload,
				},
			]);
		}
		let pageCalls = 0;
		const paged = {
			append: store.append.bind(store),
			appendEncoded: store.appendEncoded.bind(store),
			vector: store.vector.bind(store),
			missing: store.missing.bind(store),
			missingPage: async (
				id: string,
				remote: [number, number][],
				options?: Parameters<SqlitePatchStore["missingPage"]>[2],
			) => {
				pageCalls++;
				return store.missingPage(id, remote, options);
			},
		};
		const connect = encodeMessage({ kind: 1, docId, requestId: 9, vv: [] });
		const streamed = await streamStoreMessage(paged, connect);
		// Only the first page has been read so far.
		expect(pageCalls).toBe(1);
		const iterator = streamed.responses[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(pageCalls).toBe(1);
		const frames: Uint8Array[] = [first.value!];
		for (;;) {
			const next = await iterator.next();
			if (next.done) break;
			frames.push(next.value);
		}
		expect(frames.length).toBeGreaterThan(1);
		expect(pageCalls).toBe(frames.length);
		const messages = frames.map((f) => decodeMessage(f));
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]!;
			expect(msg.kind).toBe(2);
			if (msg.kind === 2) {
				expect(msg.found).toBe(true);
				expect(msg.complete).toBe(i === messages.length - 1);
				expect(msg.vv).toEqual([[70001, 13]]);
			}
		}
		const allRows = messages.flatMap((m) => (m.kind === 2 ? m.rows : []));
		expect(allRows).toEqual(await store.missing(docId, []));
	});

	test("a grouped upload near 8 MiB reaches every envelope in bounded frames, encoded once each", () => {
		const Big = definePulse(
			"RelayBig",
			versioned(object({ title: "string" })),
		).materialize();
		const options = (sessionId: number) => ({
			...defaultPulseOptions,
			sessionId,
			scope: createPulseScope(),
		});
		const writer = createPulse(Big, { id: "big", title: "" }, options(65536));
		const base = exportPulseUpdates(writer, [], { peerVersion: 2 });
		const start = getPulseMeta(writer).log.vector;
		for (let i = 0; i < 4096; i++) writer.title = String(i).padStart(2000, "x");
		const [upload, ...more] = exportPulseUpdates(writer, start, {
			peerVersion: 2,
		});
		expect(more).toEqual([]);
		expect(upload![0]).toBe(2);
		const uploaded = decodeMessage(upload!);
		if (uploaded.kind !== 4) throw new Error("Expected an update");
		const vv = getPulseMeta(writer).log.vector;
		const broadcast = { rows: uploaded.rows, vv };
		expect(() => encodeBroadcast("big", broadcast, 1)).toThrow("8 MiB");
		expect(encodeBroadcastFrames("big", broadcast, 2)).toEqual([
			upload as Uint8Array<ArrayBuffer>,
		]);

		const relay = new PulseRelay();
		const inbox = (protocolVersion: 1 | 2) => {
			const frames: Uint8Array[] = [];
			const peer = relay.open((bytes) => frames.push(bytes), {
				protocolVersion,
			});
			peer.receive(
				encodeMessage({ kind: 1, docId: "big", requestId: 1, vv: [] }),
			);
			return { peer, frames };
		};
		const sender = inbox(2);
		const legacy = inbox(1);
		const other = inbox(1);
		const modern = inbox(2);
		for (const frame of [...base, upload!]) sender.peer.receive(frame);
		const updates = (frames: Uint8Array[]) => frames.slice(2); // The sync, then the base update.
		expect(decodeMessage(sender.frames.at(-1)!)).toEqual({
			kind: 5,
			docId: "big",
			requestId: 0,
			vv,
		});
		expect(updates(modern.frames)).toEqual([upload!]);
		const chunks = updates(legacy.frames);
		expect(chunks.length).toBeGreaterThan(1);
		// The same frames, not a copy per peer.
		chunks.forEach((frame, i) => expect(updates(other.frames)[i]).toBe(frame));
		for (const frame of chunks) {
			expect(frame[0]).toBe(1);
			expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
			expect(decodeMessage(frame)).toMatchObject({ kind: 4, vv });
		}
		// Applied in order, the chunks rebuild the writer's document exactly.
		const replica = createRuntime(Big, "big", options(65537)) as typeof writer;
		applyPulseUpdates(replica, legacy.frames);
		expect(snapshotPulse(replica)).toEqual(snapshotPulse(writer));
		expect(getPulseMeta(replica).log.missing([])).toEqual(
			getPulseMeta(writer).log.missing([]),
		);
	});

	test("a sender whose socket fails still forwards what it stored", () => {
		const relay = new PulseRelay();
		let failing = false;
		const writer = relay.open(() => {
			if (failing) throw new Error("Socket gone");
		});
		const received: Uint8Array[] = [];
		const reader = relay.open((bytes) => received.push(bytes));
		const connect = encodeMessage({
			kind: 1,
			docId: "doc",
			requestId: 1,
			vv: [],
		});
		writer.receive(connect);
		reader.receive(connect);
		received.length = 0;
		const pulse = createPulse(Document, data("doc"), {
			scope: createPulseScope(),
		});
		const upload = exportPulseUpdates(pulse, []);
		failing = true;
		for (const frame of upload)
			expect(() => writer.receive(frame)).toThrow("Socket gone");
		expect(received.map((frame) => decodeMessage(frame).kind)).toEqual(
			upload.map(() => 4),
		);
		expect(relay.getLog("doc")?.vector).toEqual(getPulseMeta(pulse).log.vector);
		// Sent again, the rows are duplicates: nothing more is forwarded.
		failing = false;
		for (const frame of upload) writer.receive(frame);
		expect(received).toHaveLength(upload.length);
	});
});
