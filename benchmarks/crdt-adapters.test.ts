import { expect, test } from "bun:test";
import { createReplica, fixture, type Engine } from "./crdt-adapters";

const engines: Engine[] = ["pulsify", "json-joy", "yjs", "loro"];
for (const engine of engines) {
	test(`${engine}: same editable shape, serialization and isolated initial input`, () => {
		const input = fixture(10);
		const replica = createReplica(engine, input);
		const peer = createReplica(engine, undefined, 65537);
		try {
			expect(replica.snapshot()).toEqual(input);
			const initial = replica.exportFull();
			expect(initial.bytes).toBeGreaterThan(0);
			peer.importFull(initial);
			expect(peer.snapshot()).toEqual(input);
			const version = peer.checkpoint();
			replica.setCount(7);
			replica.setTitle("changed");
			replica.append({ value: 12, label: "appended" });
			replica.removeFirst();
			const update = replica.exportSince(version);
			version.dispose();
			expect(update.bytes).toBeGreaterThan(0);
			peer.importDelta(update);
			peer.importDelta(update);
			expect(peer.snapshot()).toEqual(replica.snapshot());
			expect(peer.readCount()).toBe(7);
			expect(input).toEqual(fixture(10));
		} finally {
			replica.dispose();
			peer.dispose();
		}
	});
	test(`${engine}: concurrent offline edits converge without replacing editable nested values`, () => {
		const a = createReplica(engine, fixture(10));
		const b = createReplica(engine, undefined, 65537);
		try {
			b.importFull(a.exportFull());
			a.setCount(7);
			a.append({ value: 100, label: "a" });
			b.setTitle("offline");
			b.append({ value: 101, label: "b" });
			const va = a.checkpoint();
			const vb = b.checkpoint();
			const toA = b.exportSince(va);
			const toB = a.exportSince(vb);
			va.dispose();
			vb.dispose();
			a.importDelta(toA);
			b.importDelta(toB);
			expect(a.snapshot()).toEqual(b.snapshot());
			expect(a.readCount()).toBe(7);
			expect(a.snapshot().title).toBe("offline");
			expect(a.snapshot().items).toHaveLength(12);
			a.setCount(8);
			expect(a.readCount()).toBe(8);
		} finally {
			a.dispose();
			b.dispose();
		}
	});
}
test("proxy-free Pulsify uses the same mutation pipeline and produces identical encoded rows", () => {
	const proxy = createReplica("pulsify", fixture(10));
	const direct = createReplica("pulsify", fixture(10), 65536, true);
	try {
		for (let i = 1; i <= 20; i++) {
			proxy.setCount(i);
			direct.setCount(i);
		}
		expect(proxy.snapshot()).toEqual(direct.snapshot());
		expect(proxy.exportFull()).toEqual(direct.exportFull());
	} finally {
		proxy.dispose();
		direct.dispose();
	}
});

test("Yjs V1 also preserves the same editable state and incremental updates", () => {
	const a = createReplica("yjs", fixture(10), 65536, false, true);
	const b = createReplica("yjs", undefined, 65537, false, true);
	try {
		b.importFull(a.exportFull());
		const version = b.checkpoint();
		a.setCount(9);
		b.importDelta(a.exportSince(version));
		version.dispose();
		expect(a.snapshot()).toEqual(b.snapshot());
		expect(b.readCount()).toBe(9);
	} finally {
		a.dispose();
		b.dispose();
	}
});
for (const engine of engines)
	test(`${engine}: sixteen conflicting peers converge independently of delivery order`, () => {
		const base = createReplica(engine, fixture(10));
		const state = base.exportFull();
		const replicas = Array.from({ length: 16 }, (_, i) =>
			createReplica(engine, undefined, 65537 + i),
		);
		const reverse = createReplica(engine, undefined, 65600);
		try {
			for (const replica of replicas) replica.importFull(state);
			reverse.importFull(state);
			const version = reverse.checkpoint();
			const updates = replicas.map((replica, i) => {
				replica.setCount(i + 1);
				return replica.exportSince(version);
			});
			version.dispose();
			for (const update of updates) replicas[0]!.importDelta(update);
			for (const update of updates.reverse()) reverse.importDelta(update);
			expect(reverse.snapshot()).toEqual(replicas[0]!.snapshot());
			expect(reverse.readCount()).toBeGreaterThan(0);
			expect(reverse.readCount()).toBeLessThanOrEqual(16);
		} finally {
			base.dispose();
			reverse.dispose();
			for (const replica of replicas) replica.dispose();
		}
	});
