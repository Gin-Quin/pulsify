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
	encodeMessage,
	decodeMessage,
	type Connector,
} from "../source/index";
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
});
