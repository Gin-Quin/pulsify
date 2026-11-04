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
	getPulseVersions,
	createMemoryConnector,
	connectPulse,
	disconnectPulse,
	recoverPulseHistory,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";
import {
	stateDeltaOf,
	encodeStateMessage,
} from "../source/protocol/stateDeltas.js";
import { rowsFromFrame } from "../source/storage/rows.js";
import { PulseRelay } from "../source/protocol/PulseRelay.js";
const D = definePulse(
	"State",
	object({ title: "string", count: "float64", items: array("string") }),
).materialize();
const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
function fixture(connectors: ReturnType<typeof createMemoryConnector>[] = []) {
	const a = createPulse(
		D,
		{ id: "state", title: "start", count: 0, items: [] },
		{ ...opts(65536), connectors },
	);
	const b = createRuntime(D, a.id, { ...opts(65537), connectors }) as typeof a;
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
test("hybrid scalar merge converges without claiming omitted physical history; exact backfill restores it", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) {
			f.a.count = i;
			f.b.title = `offline-${i}`;
		}
		const va = f.ma.log.vector,
			vb = f.mb.log.vector,
			ha = exportPulseUpdates(f.a, vb, { peerVersion: 2 }),
			hb = exportPulseUpdates(f.b, va, { peerVersion: 2 }),
			sa = exportPulseUpdates(f.a, vb, { peerVersion: 3 }),
			sb = exportPulseUpdates(f.b, va, { peerVersion: 3 });
		expect(sa).toHaveLength(1);
		expect(sa[0]![0]).toBe(3);
		expect(sa[0]!.length).toBeLessThan(ha[0]!.length / 4);
		applyPulseUpdates(f.a, sb);
		applyPulseUpdates(f.b, sa);
		expect(snapshotPulse(f.a)).toEqual(snapshotPulse(f.b));
		expect(f.ma.log.vector).toEqual(f.mb.log.vector);
		expect(f.ma.log.size).toBe(102);
		expect(getPulseVersions(f.a).history).not.toEqual(
			getPulseVersions(f.a).state,
		);
		expect(() => f.ma.log.missing([])).toThrow("state-only");
		expect(() => exportPulseUpdates(f.a, [], { peerVersion: 2 })).toThrow();
		const before = snapshotPulse(f.a);
		applyPulseUpdates(f.a, sb);
		expect(snapshotPulse(f.a)).toEqual(before);
		applyPulseUpdates(f.a, hb);
		applyPulseUpdates(f.b, ha);
		expect(f.ma.log.size).toBe(201);
		expect(getPulseVersions(f.a).history).toEqual(getPulseVersions(f.a).state);
		expect(snapshotPulse(f.a)).toEqual(before);
		expect(f.ma.log.missing([])).toHaveLength(201);
	} finally {
		f.done();
	}
});
test("state forwarding preserves causal creation order and future edits; small and sequence updates keep exact operations", () => {
	const f = fixture();
	const c = createRuntime(D, f.a.id, opts(65538)) as typeof f.a;
	try {
		for (let i = 1; i <= 100; i++) f.a.count = i;
		applyPulseUpdates(
			f.b,
			exportPulseUpdates(f.a, f.mb.log.vector, { peerVersion: 3 }),
		);
		f.b.title = "after-state";
		applyPulseUpdates(c, exportPulseUpdates(f.b, [], { peerVersion: 3 }));
		expect(snapshotPulse(c)).toEqual(snapshotPulse(f.b));
		expect(getPulseVersions(c).state).toEqual(getPulseVersions(f.b).state);
		const last = f.mb.log.missing(f.ma.log.vector);
		expect(last[0]!.dependencies).toContainEqual([65536, 102]);
		const base = f.ma.log.vector;
		f.a.items.push("x");
		f.a.title = "small";
		const frames = exportPulseUpdates(f.a, base, { peerVersion: 3 });
		expect(frames.every((b) => b[0] !== 3)).toBe(true);
	} finally {
		destroyPulse(c);
		f.done();
	}
});
test("state envelopes cannot be persisted, silently downgraded, or uploaded to an authoritative relay", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 100; i++) f.a.count = i;
		const frame = exportPulseUpdates(f.a, f.mb.log.vector, {
				peerVersion: 3,
			})[0]!,
			m = decodeMessage(frame);
		if (!("rows" in m)) throw Error();
		expect(() => rowsFromFrame(frame)).toThrow("durable");
		expect(() => encodeMessage(m)).toThrow();
		expect(encodeMessage(m, { peerVersion: 3 })).toEqual(new Uint8Array(frame));
		const messages: any[] = [],
			relay = new PulseRelay(),
			peer = relay.open((b) => messages.push(decodeMessage(b)), {
				protocolVersion: 3,
			});
		peer.receive(
			encodeMessage({ kind: 1, docId: f.a.id, requestId: 1, vv: [] }),
		);
		peer.receive(frame);
		expect(messages.at(-1).kind).toBe(6);
		expect(relay.getLog(f.a.id)).toBeUndefined();
		peer.close();
		const d = stateDeltaOf(m.rows)!;
		expect(() =>
			applyPulseUpdates(f.b, [
				encodeStateMessage(m as any, {
					...d,
					clock: d.clock + 1,
					count: d.count - 1,
					lamport: d.lamport + 1,
				}),
			]),
		).toThrow("causal base");
		expect(f.mb.log.size).toBe(1);
	} finally {
		f.done();
	}
});
test("memory relay keeps full uploads while state downloads can explicitly recover exact history", async () => {
	const relay = new PulseRelay(),
		connector = createMemoryConnector(relay),
		f = fixture([connector]);
	try {
		await connectPulse(f.a).synced;
		disconnectPulse(f.a);
		for (let i = 1; i <= 100; i++) f.a.count = i;
		await connectPulse(f.a).synced;
		await connectPulse(f.b).synced;
		expect(snapshotPulse(f.b)).toEqual(snapshotPulse(f.a));
		expect(relay.getLog(f.a.id)!.size).toBe(101);
		expect(getPulseVersions(f.b).history).not.toEqual(
			getPulseVersions(f.b).state,
		);
		await recoverPulseHistory(f.b);
		expect(getPulseVersions(f.b).history).toEqual(getPulseVersions(f.b).state);
		expect(f.mb.log.size).toBe(101);
	} finally {
		disconnectPulse(f.a);
		disconnectPulse(f.b);
		f.done();
	}
});
test("a condensed causal prefix releases pending exact edits atomically and duplicate state stays harmless after replacement", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) f.a.count = i;
		const delta = exportPulseUpdates(f.a, f.mb.log.vector, { peerVersion: 3 });
		const prefix = f.ma.log.vector;
		f.a.title = "future";
		const future = exportPulseUpdates(f.a, prefix, { peerVersion: 2 });
		applyPulseUpdates(f.b, future);
		expect(f.mb.log.pendingCount).toBe(1);
		expect(f.b.title).toBe("start");
		applyPulseUpdates(f.b, delta);
		expect(f.mb.log.pendingCount).toBe(0);
		expect(snapshotPulse(f.b)).toEqual(snapshotPulse(f.a));
		applyPulseUpdates(f.b, delta);
		expect(f.b.title).toBe("future");
	} finally {
		f.done();
	}
});
test("conflicting historical metadata and last values cannot hydrate a state-covered range", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) f.a.count = i;
		const base = f.mb.log.vector,
			full = exportPulseUpdates(f.a, base, { peerVersion: 2 });
		applyPulseUpdates(f.b, exportPulseUpdates(f.a, base, { peerVersion: 3 }));
		const message = decodeMessage(full[0]!);
		if (!("rows" in message)) throw Error();
		const before = snapshotPulse(f.b),
			versions = getPulseVersions(f.b);
		const first = message.rows[0]!,
			second = message.rows[1]!;
		expect(() =>
			f.mb.applyRows([{ ...first, operations: second.operations }]),
		).toThrow();
		expect(snapshotPulse(f.b)).toEqual(before);
		expect(getPulseVersions(f.b)).toEqual(versions);
		applyPulseUpdates(f.b, full);
		expect(getPulseVersions(f.b).history).toEqual(getPulseVersions(f.b).state);
	} finally {
		f.done();
	}
});
test("many state-only peers converge across reversed concurrent deliveries and forward to a fresh peer", () => {
	const f = fixture(),
		peers = Array.from(
			{ length: 12 },
			(_, i) => createRuntime(D, f.a.id, opts(65538 + i)) as typeof f.a,
		);
	try {
		const root = exportPulseUpdates(f.a, []);
		for (const p of peers) applyPulseUpdates(p, root);
		for (let j = 0; j < peers.length; j++)
			for (let i = 1; i <= 64; i++) peers[j]!.count = 100 * j + i;
		const packets = peers.map((p) =>
			exportPulseUpdates(p, f.ma.log.vector, { peerVersion: 3 }),
		);
		for (const packet of packets) applyPulseUpdates(f.a, packet);
		for (const packet of [...packets].reverse()) applyPulseUpdates(f.b, packet);
		expect(snapshotPulse(f.a)).toEqual(snapshotPulse(f.b));
		expect(getPulseVersions(f.a).state).toEqual(getPulseVersions(f.b).state);
		const c = createRuntime(D, f.a.id, opts(65600)) as typeof f.a;
		try {
			applyPulseUpdates(c, exportPulseUpdates(f.a, [], { peerVersion: 3 }));
			expect(snapshotPulse(c)).toEqual(snapshotPulse(f.a));
		} finally {
			destroyPulse(c);
		}
	} finally {
		for (const p of peers) destroyPulse(p);
		f.done();
	}
});
test("condensed coverage cannot release a pending actor fork", () => {
	const f = fixture();
	try {
		const base = f.mb.log.vector;
		for (let i = 1; i <= 100; i++) f.a.count = i;
		const delta = exportPulseUpdates(f.a, base, { peerVersion: 3 }),
			end = f.ma.log.vector;
		f.a.count = 101;
		const future = decodeMessage(exportPulseUpdates(f.a, end)[0]!);
		if (!("rows" in future)) throw Error();
		applyPulseUpdates(f.b, [
			encodeMessage({
				...future,
				rows: future.rows.map((r) => ({ ...r, dependencies: base })),
			}),
		]);
		expect(f.mb.log.pendingCount).toBe(1);
		expect(() => applyPulseUpdates(f.b, delta)).toThrow("fork");
		expect(f.mb.log.vector).toEqual(base);
		expect(f.mb.log.pendingCount).toBe(1);
		expect(f.b.count).toBe(0);
	} finally {
		f.done();
	}
});
test("recovery never reports success when the history source supplies no missing operations", async () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) f.a.count = i;
		applyPulseUpdates(
			f.b,
			exportPulseUpdates(f.a, f.mb.log.vector, { peerVersion: 3 }),
		);
		const before = getPulseVersions(f.b);
		await expect(recoverPulseHistory(f.b)).rejects.toThrow("exact history");
		expect(getPulseVersions(f.b)).toEqual(before);
	} finally {
		f.done();
	}
});
test("recovery detects journal loss even when a connected source returns a complete empty sync", async () => {
	const relay = new PulseRelay(),
		f = fixture([createMemoryConnector(relay)]);
	try {
		const base = f.mb.log.vector;
		for (let i = 1; i <= 100; i++) f.a.count = i;
		applyPulseUpdates(f.b, exportPulseUpdates(f.a, base, { peerVersion: 3 }));
		await connectPulse(f.a).synced;
		await connectPulse(f.b).synced;
		(relay as any).documents.clear();
		await expect(recoverPulseHistory(f.b)).rejects.toThrow("exact history");
		expect(getPulseVersions(f.b).history).toEqual(base);
	} finally {
		disconnectPulse(f.a);
		disconnectPulse(f.b);
		f.done();
	}
});
test("state framing rejects truncation, trailing bytes, noncanonical integers and invalid typed values without advancing state", () => {
	const f = fixture();
	try {
		for (let i = 1; i <= 100; i++) f.a.count = i;
		const frame = exportPulseUpdates(f.a, f.mb.log.vector, {
				peerVersion: 3,
			})[0]!,
			message = decodeMessage(frame);
		if (!("rows" in message)) throw Error();
		const delta = stateDeltaOf(message.rows)!;
		for (let i = 0; i < frame.length; i++)
			expect(() => decodeMessage(frame.slice(0, i))).toThrow();
		expect(() => decodeMessage(new Uint8Array([...frame, 0]))).toThrow();
		expect(() =>
			decodeMessage(new Uint8Array([3, 2, 132, 0, ...frame.slice(3)])),
		).toThrow();
		expect(() =>
			decodeMessage(encodeStateMessage({ ...message, vv: [] }, delta)),
		).toThrow();
		const nan = new Uint8Array(8);
		new DataView(nan.buffer).setFloat64(0, NaN, true);
		expect(() =>
			applyPulseUpdates(f.b, [
				encodeStateMessage(message, { ...delta, data: nan }),
			]),
		).toThrow();
		expect(f.b.count).toBe(0);
		expect(f.mb.log.size).toBe(1);
		frame.fill(0);
		f.mb.applyRows(message.rows);
		expect(f.b.count).toBe(100);
	} finally {
		f.done();
	}
});
test("a state-only client backfills exact history automatically when connecting to a legacy endpoint", async () => {
	const relay = new PulseRelay();
	Object.defineProperty(relay, "protocolVersion", { value: 1 });
	const f = fixture([createMemoryConnector(relay)]);
	try {
		const base = f.mb.log.vector;
		for (let i = 1; i <= 100; i++) f.a.count = i;
		applyPulseUpdates(f.b, exportPulseUpdates(f.a, base, { peerVersion: 3 }));
		await connectPulse(f.a).synced;
		await connectPulse(f.b).synced;
		expect(getPulseVersions(f.b).history).toEqual(getPulseVersions(f.b).state);
		expect(f.mb.log.size).toBe(101);
	} finally {
		disconnectPulse(f.a);
		disconnectPulse(f.b);
		f.done();
	}
});
