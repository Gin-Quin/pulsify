import { expect, test } from "bun:test";
import {
	connectPulse,
	createPulse,
	createWebSocketConnector,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	snapshotPulse,
} from "../source/index";
import { rowToPatch } from "../source/connection/PulsePatch";
import type { RelayPeer } from "../source/protocol/PulseRelay";
import { Document, data, options, eventually } from "./helpers";

test("real WebSocket transport synchronizes documents and closes all sessions", async () => {
	const relay = new PulseRelay(rowToPatch);
	const server = Bun.serve<{ peer?: RelayPeer }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request, { data: {} })) return;
			return new Response("Upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.data.peer = relay.open((bytes) => {
					socket.sendBinary(bytes);
				});
			},
			message(socket, message) {
				if (typeof message === "string") {
					socket.close(1003);
					return;
				}
				socket.data.peer!.receive(new Uint8Array(message));
			},
			close(socket) {
				socket.data.peer?.close();
			},
		},
	});
	const connector = createWebSocketConnector(`ws://127.0.0.1:${server.port}`);
	const a = createPulse(Document, data(), {
		...options(),
		connectors: [connector],
	});
	let b;
	try {
		await connectPulse(a).synced;
		b = await loadPulse(Document, a.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		a.nested.count = 99;
		a.items.push({ value: 19 });
		await eventually(() => expect(snapshotPulse(a)).toEqual(snapshotPulse(b!)));
		expect(b.nested.count).toBe(99);
		destroyPulse(b);
		destroyPulse(a);
		await eventually(() => expect(relay.peerCount).toBe(0));
	} finally {
		if (b) destroyPulse(b);
		destroyPulse(a);
		server.stop(true);
	}
});

test("scheduled sends from a closed connection cannot fail its replacement", async () => {
	const { createMemoryConnector, disconnectPulse, PulseRelay } = await import(
		"../source/index"
	);
	const connector = createMemoryConnector(new PulseRelay());
	const pulse = createPulse(Document, data(), {
		...options(),
		connectors: [connector],
	});
	await connectPulse(pulse).synced;
	for (let i = 0; i < 20; i++) {
		pulse.nested.count = i;
		disconnectPulse(pulse);
		await connectPulse(pulse).synced;
		expect(getPulseMeta(pulse).connections[0]!.status).toBe("synced");
	}
	destroyPulse(pulse);
});
