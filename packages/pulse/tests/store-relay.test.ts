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
	encodeBroadcast,
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
});
