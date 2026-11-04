import { expect, test } from "bun:test";
import { object, array } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	createPulseScope,
	getPulseMeta,
	destroyPulse,
	snapshotPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	createMemoryConnector,
	connectPulse,
	disconnectPulse,
	loadPulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";
import { PulseRelay } from "../source/protocol/PulseRelay.js";
import { scalarRunOf } from "../source/protocol/scalarRuns.js";
const D = definePulse(
	"Grouped",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array("string"),
	}),
).materialize();
const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
function fixture() {
	const a = createPulse(
		D,
		{ id: "grouped", title: "start", nested: { count: 0 }, items: [] },
		opts(65536),
	);
	const b = createRuntime(D, a.id, opts(65537)) as typeof a;
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	return {
		a,
		b,
		ma: getPulseMeta(a),
		mb: getPulseMeta(b),
		done() {
			destroyPulse(a);
			destroyPulse(b);
		},
	};
}
const plain = (r: any) => ({
	docId: r.docId,
	sid: r.sid,
	clock: r.clock,
	span: r.span,
	dependencies: r.dependencies,
	operations: r.operations,
});
const sorted = (rows: any[]) =>
	rows.map(plain).sort((a, b) => a.sid - b.sid || a.clock - b.clock);
test("public grouped exchange preserves every exact row, all partial vectors, forwarding and fresh replay", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) {
			f.a.nested.count = i;
			f.b.title = `offline-${i}`;
		}
		const va = f.ma.log.vector,
			vb = f.mb.log.vector,
			toA = exportPulseUpdates(f.b, va, { peerVersion: 2 }),
			toB = exportPulseUpdates(f.a, vb, { peerVersion: 2 });
		expect(toA[0]![0]).toBe(2);
		expect(toB[0]![0]).toBe(2);
		const beforeA = f.ma.log.missing([]),
			beforeB = f.mb.log.missing([]);
		const message = decodeMessage(toB[0]!);
		if (!("rows" in message)) throw Error();
		const forwarded = encodeMessage(message, { peerVersion: 2 });
		expect(forwarded).toEqual(new Uint8Array(toB[0]!));
		const legacy = encodeMessage(message);
		expect(legacy[0]).toBe(1);
		expect(decodeMessage(legacy)).toEqual({
			...message,
			rows: message.rows.map(plain),
		});
		applyPulseUpdates(f.a, toA);
		applyPulseUpdates(f.b, toB);
		expect(snapshotPulse(f.a)).toEqual(snapshotPulse(f.b));
		expect(f.ma.log.size).toBe(201);
		expect(sorted(f.ma.log.missing([]))).toEqual(
			sorted([...beforeA, ...beforeB.slice(1)]),
		);
		for (const sid of [65536, 65537])
			for (let clock = 1; clock <= 102; clock++)
				expect(sorted(f.ma.log.missing([[sid, clock]]))).toEqual(
					sorted(f.mb.log.missing([[sid, clock]])),
				);
		const c = createRuntime(D, f.a.id, opts(65538)) as typeof f.a;
		try {
			applyPulseUpdates(c, exportPulseUpdates(f.a, [], { peerVersion: 2 }));
			expect(snapshotPulse(c)).toEqual(snapshotPulse(f.a));
		} finally {
			destroyPulse(c);
		}
		const partial = exportPulseUpdates(
			f.b,
			[
				[65536, 50],
				[65537, 101],
			],
			{ peerVersion: 2 },
		);
		expect(partial[0]![0]).toBe(2);
		const m = decodeMessage(partial[0]!);
		expect("rows" in m && m.rows[0]!.clock).toBe(50);
		f.b.title = "next";
		expect(
			f.mb.log.missing([
				[65536, 102],
				[65537, 101],
			])[0]!.dependencies,
		).toEqual([
			[65536, 102],
			[65537, 101],
		]);
	} finally {
		f.done();
	}
});
test("duplicates, overlapping deliveries and gaps take the exact general path", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 6; i++) f.a.nested.count = i;
		const base = f.mb.log.vector,
			all = exportPulseUpdates(f.a, base, { peerVersion: 2 });
		const message = decodeMessage(all[0]!);
		if (!("rows" in message)) throw Error();
		f.mb.applyRows(message.rows.slice(3));
		expect(f.mb.log.pendingCount).toBe(3);
		expect(f.b.nested.count).toBe(0);
		applyPulseUpdates(f.b, all);
		expect(f.b.nested.count).toBe(6);
		expect(f.mb.log.pendingCount).toBe(0);
		const before = snapshotPulse(f.b),
			vector = f.mb.log.vector;
		applyPulseUpdates(f.b, all);
		expect(snapshotPulse(f.b)).toEqual(before);
		expect(f.mb.log.vector).toEqual(vector);
		const conflicting = {
			...message.rows[0]!,
			operations: message.rows[1]!.operations,
		};
		expect(() => f.mb.applyRows([conflicting])).toThrow();
		expect(f.mb.log.vector).toEqual(vector);
	} finally {
		f.done();
	}
});
test("malformed and overwritten-invalid run values reject atomically; buffers are owned", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 5; i++) f.a.nested.count = i;
		const frame = exportPulseUpdates(f.a, f.mb.log.vector, {
				peerVersion: 2,
			})[0]!,
			m = decodeMessage(frame);
		if (!("rows" in m)) throw Error();
		const run = scalarRunOf(m.rows)!;
		const before = snapshotPulse(f.b),
			vector = f.mb.log.vector;
		const bad = new Uint8Array(frame);
		new DataView(bad.buffer).setFloat64(run.spans[0]!, NaN, true);
		expect(() => applyPulseUpdates(f.b, [bad])).toThrow();
		expect(snapshotPulse(f.b)).toEqual(before);
		expect(f.mb.log.vector).toEqual(vector);
		for (let n = 0; n < frame.length; n++)
			expect(() => applyPulseUpdates(f.b, [frame.subarray(0, n)])).toThrow();
		expect(() =>
			applyPulseUpdates(f.b, [new Uint8Array([...frame, 0])]),
		).toThrow();
		const bytes = Buffer.from(frame),
			decoded = decodeMessage(bytes);
		bytes.fill(0);
		if (!("rows" in decoded)) throw Error();
		f.mb.applyRows(decoded.rows);
		expect(f.b.nested.count).toBe(5);
		const row = decoded.rows[0]!;
		row.operations.fill(0);
		row.dependencies[0]![1] = 999;
		expect(f.mb.log.missing([])).toEqual(f.ma.log.missing([]));
		const other = createRuntime(D, "other", opts(65539));
		try {
			expect(() => getPulseMeta(other).applyRows(decoded.rows)).toThrow();
			expect(getPulseMeta(other).log.size).toBe(0);
		} finally {
			destroyPulse(other);
		}
	} finally {
		f.done();
	}
});
test("grouped notifications preserve one batch and existing newer winning stamp", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 6; i++) f.a.nested.count = i;
		f.b.title = "1";
		f.b.title = "2";
		f.b.title = "3";
		f.b.title = "4";
		f.b.title = "5";
		f.b.title = "6";
		f.b.nested.count = 999;
		let count = 0;
		f.mb.listeners.add(() => {
			throw Error("listener");
		});
		f.mb.rowListeners.add(() => count++);
		applyPulseUpdates(
			f.b,
			exportPulseUpdates(f.a, f.mb.log.vector, { peerVersion: 2 }),
		);
		expect(f.b.nested.count).toBe(999);
		expect(count).toBe(1);
		expect(f.mb.lastError).toBeDefined();
	} finally {
		f.done();
	}
});
test("ineligible writes and unknown endpoints retain v1", () => {
	const f = fixture();
	try {
		f.a.nested.count = 1;
		f.a.title = "different target";
		expect(
			exportPulseUpdates(f.a, f.mb.log.vector, { peerVersion: 2 })[0]![0],
		).toBe(1);
		f.a.items.push("a");
		f.a.items.push("b");
		expect(exportPulseUpdates(f.a, f.mb.log.vector)[0]![0]).toBe(1);
		expect(() => exportPulseUpdates(f.a, [], { requestId: -1 })).toThrow();
	} finally {
		f.done();
	}
});
test("actual memory sessions negotiate grouped uploads and legacy subscribers receive exact v1", async () => {
	const relay = new PulseRelay(),
		received: Uint8Array[] = [];
	const legacy = relay.open((bytes) => received.push(bytes));
	legacy.receive(
		encodeMessage({ kind: 1, docId: "memory-grouped", requestId: 1, vv: [] }),
	);
	const connector = createMemoryConnector(relay),
		a = createPulse(
			D,
			{ id: "memory-grouped", title: "x", nested: { count: 0 }, items: [] },
			{ ...opts(65536), connectors: [connector] },
		);
	let b: any;
	try {
		await connectPulse(a).synced;
		b = await loadPulse(D, a.id, {
			...opts(65537),
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(a);
		for (let i = 1; i <= 100; i++) a.nested.count = i;
		await connectPulse(a).synced;
		expect(b.nested.count).toBe(100);
		expect(relay.getLog(a.id)!.size).toBe(101);
		expect(received.every((frame) => frame[0] === 1)).toBe(true);
		const rows = relay.getLog(a.id)!.missing([]);
		expect(rows).toEqual(getPulseMeta(a).log.missing([]));
	} finally {
		destroyPulse(a);
		if (b) destroyPulse(b);
		legacy.close();
	}
});

test("real WebSocket subprotocol enables grouped traffic while an old endpoint stays v1", async () => {
	const { createWebSocketConnector } = await import("../source/index.js");
	for (const upgraded of [false, true]) {
		const relay = new PulseRelay(),
			seen: number[] = [];
		const server = Bun.serve<{
			peer?: ReturnType<PulseRelay["open"]>;
			version: 1 | 2;
		}>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				const version =
					upgraded &&
					request.headers.get("sec-websocket-protocol")?.includes("pulsify-v2")
						? 2
						: 1;
				if (
					server.upgrade(request, {
						data: { version },
						...(version === 2
							? { headers: { "Sec-WebSocket-Protocol": "pulsify-v2" } }
							: {}),
					})
				)
					return;
				return new Response("upgrade", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.data.peer = relay.open((bytes) => socket.sendBinary(bytes), {
						protocolVersion: socket.data.version,
					});
				},
				message(socket, message) {
					if (typeof message === "string") throw Error();
					const bytes = new Uint8Array(message);
					seen.push(bytes[0]!);
					socket.data.peer!.receive(bytes);
				},
				close(socket) {
					socket.data.peer?.close();
				},
			},
		});
		const connector = createWebSocketConnector(
				`ws://127.0.0.1:${server.port}`,
				undefined,
				{ protocolVersion: upgraded ? 2 : 1 },
			),
			a = createPulse(
				D,
				{ id: "ws-grouped", title: "x", nested: { count: 0 }, items: [] },
				{ ...opts(65536), connectors: [connector] },
			);
		let b: any;
		try {
			await connectPulse(a).synced;
			b = await loadPulse(D, a.id, {
				...opts(65537),
				connectors: [connector],
				waitFor: "all",
			});
			disconnectPulse(a);
			for (let i = 1; i <= 100; i++) a.nested.count = i;
			await connectPulse(a).synced;
			for (let i = 0; i < 100 && b.nested.count !== 100; i++)
				await Bun.sleep(2);
			expect(b.nested.count).toBe(100);
			expect(seen.includes(2)).toBe(upgraded);
		} finally {
			destroyPulse(a);
			if (b) destroyPulse(b);
			server.stop(true);
		}
	}
});

test("storage row equality reads owned operation bytes once per row", async () => {
	const { sameRow } = await import("../source/storage/rows.js");
	let reads = 0;
	const bytes = new Uint8Array(128000).fill(7),
		row = {
			docId: "equal",
			sid: 65536,
			clock: 1,
			span: 1,
			dependencies: [],
			get operations() {
				reads++;
				return new Uint8Array(bytes);
			},
		};
	expect(sameRow(row, row)).toBe(true);
	expect(reads).toBe(2);
});
