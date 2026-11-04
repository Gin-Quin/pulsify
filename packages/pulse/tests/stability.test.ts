import { expect, test } from "bun:test";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	snapshotPulse,
} from "../source/index";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage";
import { Document, data, options } from "./helpers";

// Seeded schedules are reproducible. Dependencies must survive arbitrary transport order.
for (let seed = 1; seed <= 20; seed++) {
	test(`convergence with concurrent edits, reordering and duplicates (seed ${seed})`, async () => {
		let state = seed;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 2 ** 32;
		};
		const connector = createMemoryConnector(new PulseRelay());
		const a = createPulse(Document, data(`seed-${seed}`), {
			...options(),
			sessionId: 65536,
			connectors: [connector],
		});
		await connectPulse(a).synced;
		const b = await loadPulse(Document, a.id, {
			...options(),
			sessionId: 65537,
			connectors: [connector],
			waitFor: "all",
		});
		const c = await loadPulse(Document, a.id, {
			...options(),
			sessionId: 65538,
			connectors: [connector],
			waitFor: "all",
		});
		const replicas = [a, b, c];
		for (const replica of replicas) disconnectPulse(replica);
		for (let wave = 0; wave < 4; wave++) {
			for (const replica of replicas)
				for (let edit = 0; edit < 5; edit++) {
					const n = Math.floor(random() * 1000);
					switch (n % 5) {
						case 0:
							replica.title = `title-${n}`;
							break;
						case 1:
							replica.nested.count = n;
							break;
						case 2:
							replica.items.push({ value: n });
							break;
						case 3:
							replica.items.unshift({ value: n });
							break;
						case 4:
							if (replica.items.length)
								replica.items.splice(
									Math.floor(random() * replica.items.length),
									1,
								);
							break;
					}
				}
			const all = replicas.flatMap((replica) =>
				getPulseMeta(replica).log.missing([]),
			);
			for (const target of replicas) {
				const shuffled = all
					.map((row) => ({ row, order: random() }))
					.sort((a, b) => a.order - b.order);
				for (const { row } of shuffled) {
					const message = decodeMessage(
						encodeMessage({
							kind: 4,
							docId: target.id,
							requestId: 0,
							vv: [],
							rows: [row],
						}),
					);
					if (message.kind === 4) getPulseMeta(target).applyRows(message.rows);
				}
				expect(getPulseMeta(target).log.pendingCount).toBe(0);
			}
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
			expect(snapshotPulse(a)).toEqual(snapshotPulse(c));
		}
		for (const replica of replicas) destroyPulse(replica);
	});
}
test("repeated creation and destruction release identity maps, subscriptions and sessions", async () => {
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
	for (let i = 0; i < 100; i++) {
		const config = { ...options(), connectors: [connector] };
		const pulse = createPulse(Document, data(), config);
		await connectPulse(pulse).synced;
		const meta = getPulseMeta(pulse);
		destroyPulse(pulse);
		expect(config.scope.pulses.size).toBe(0);
		expect(meta.listeners.size).toBe(0);
		expect(meta.rowListeners.size).toBe(0);
		expect(relay.peerCount).toBe(0);
	}
});
