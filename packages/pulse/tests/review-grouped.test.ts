import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import {
	createEncoder,
	object,
	toUint8Array,
	writeVarUint8Array,
} from "@gin-quin/codec";
import {
	encodeOwnedRun,
	writeRunHeader,
} from "../source/protocol/scalarRuns.js";
import {
	applyPulseUpdates,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createWebSocketConnector } from "../source/connectors/websocket.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";
const D = definePulse(
	"ReviewGrouped",
	object({ value: "string" }),
).materialize();
const fixture = () =>
	createPulse(
		D,
		{ id: "review-grouped", value: "" },
		{ scope: createPulseScope(), sessionId: 65536 },
	);
test("review: forwarding a larger vector retains the expanded byte budget", () => {
	const run = {
		sid: 65536,
		clock: 1,
		count: 63,
		lamport: 1,
		schema: "a".repeat(1048500),
		target: "x",
		field: "f",
		layout: 2,
		external: [],
	};
	const encoder = createEncoder();
	writeRunHeader(
		encoder,
		{ kind: 4, docId: "d", requestId: 0, vv: [], rows: [] },
		run,
	);
	for (let i = 0; i < run.count; i++)
		writeVarUint8Array(encoder, new Uint8Array([0]));
	const message = decodeMessage(toUint8Array(encoder));
	if (!("rows" in message)) throw Error("Expected rows");
	message.vv = Array.from({ length: 1024 }, (_, i) => [65536 + i, 1]);
	expect(encodeOwnedRun(message)).toBeUndefined();
});
test("review: forwarding multiple runs falls back to chunked export", () => {
	const a = fixture(),
		b = createRuntime(D, a.id, {
			...defaultPulseOptions,
			scope: createPulseScope(),
			sessionId: 65537,
		}) as typeof a;
	try {
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		const base = getPulseMeta(b).log.vector;
		for (let group = 0; group < 31; group++) {
			const vv = getPulseMeta(b).log.vector;
			for (let i = 0; i < 1000; i++) a.value = `${group}:${i}`;
			applyPulseUpdates(b, exportPulseUpdates(a, vv, { peerVersion: 2 }));
		}
		const frames = exportPulseUpdates(b, base, { peerVersion: 2 });
		let rows = 0;
		for (const frame of frames) {
			const message = decodeMessage(frame);
			if ("rows" in message) rows += message.rows.length;
		}
		expect(rows).toBe(31000);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});
test("review: a legacy Bun upgrade must not advertise grouped support", async () => {
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: { message() {} },
	});
	let session:
		| Awaited<ReturnType<ReturnType<typeof createWebSocketConnector>["open"]>>
		| undefined;
	try {
		session = await createWebSocketConnector(
			`ws://localhost:${server.port}`,
		).open({
			docId: "review-grouped",
			signal: new AbortController().signal,
			onMessage() {},
			onClose() {},
		});
		expect(session.protocolVersion).toBe(1);
	} finally {
		session?.close();
		server.stop(true);
	}
});
test("review: a legacy HTTP upgrade without subprotocol remains compatible", async () => {
	const server = createServer();
	let peer: Duplex | undefined, protocols: string | undefined;
	server.on("upgrade", (request, socket) => {
		peer = socket;
		protocols = request.headers["sec-websocket-protocol"];
		const accept = createHash("sha1")
			.update(
				`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
			)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	let session:
		| Awaited<ReturnType<ReturnType<typeof createWebSocketConnector>["open"]>>
		| undefined;
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw Error("Expected TCP address");
		session = await createWebSocketConnector(
			`ws://127.0.0.1:${address.port}`,
		).open({
			docId: "review-grouped",
			signal: new AbortController().signal,
			onMessage() {},
			onClose() {},
		});
		expect(protocols).toBeUndefined();
		expect(session.protocolVersion).toBe(1);
	} finally {
		session?.close();
		peer?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
test("review: grouped export must reject an over-limit single patch", () => {
	const pulse = fixture();
	try {
		const vv = getPulseMeta(pulse).log.vector;
		pulse.value = "a".repeat(1024 * 1024);
		pulse.value = "b".repeat(1024 * 1024);
		expect(() => exportPulseUpdates(pulse, vv, { peerVersion: 2 })).toThrow(
			"1 MiB",
		);
	} finally {
		destroyPulse(pulse);
	}
});
test("review: grouped encode must retain document-row consistency validation", () => {
	const pulse = fixture();
	try {
		const vv = getPulseMeta(pulse).log.vector;
		pulse.value = "a";
		pulse.value = "b";
		const message = decodeMessage(
			exportPulseUpdates(pulse, vv, { peerVersion: 2 })[0]!,
		);
		expect(() =>
			encodeMessage(
				{ ...message, docId: "other-document" },
				{ peerVersion: 2 },
			),
		).toThrow();
	} finally {
		destroyPulse(pulse);
	}
});
