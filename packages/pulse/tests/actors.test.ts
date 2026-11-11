import { afterEach, describe, expect, test } from "bun:test";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	type Connector,
	type Pulse,
	type PulseScope,
} from "../source/index";
import { leaseActor, leasedActor } from "../source/pulses/actors";
import { Document, data, eventually } from "./helpers";

/**
 * Web Locks and localStorage shared by several pages. A page keeps its locks
 * until `close()`, as a tab does until it is closed or crashes.
 */
function browser() {
	const held = new Map<string, object>();
	const waiting = new Map<string, (() => void)[]>();
	const items = new Map<string, string>();
	const release = (name: string) => {
		held.delete(name);
		waiting.get(name)?.shift()?.();
	};
	const storage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
	};
	const page = () => {
		const self = {};
		const locks = {
			async request(
				name: string,
				options: { ifAvailable?: boolean },
				callback: (lock: object | null) => unknown,
			) {
				if (held.has(name)) {
					if (options.ifAvailable) return callback(null);
					await new Promise<void>((resolve) => {
						const queue = waiting.get(name) ?? [];
						waiting.set(name, queue);
						queue.push(resolve);
					});
				}
				held.set(name, self);
				try {
					return await callback({ name });
				} finally {
					if (held.get(name) === self) release(name);
				}
			},
		};
		return {
			scope: createPulseScope(),
			/** Make this page the one whose globals the next call sees. */
			enter() {
				Object.defineProperty(globalThis.navigator, "locks", {
					value: locks,
					configurable: true,
				});
				Object.defineProperty(globalThis, "localStorage", {
					value: storage,
					configurable: true,
				});
				return this;
			},
			close() {
				for (const [name, owner] of [...held])
					if (owner === self) release(name);
			},
		};
	};
	return { page, items };
}

const pulses: Pulse<any>[] = [];
const track = <P extends Pulse<any>>(pulse: P): P => {
	pulses.push(pulse);
	return pulse;
};
afterEach(() => {
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
	delete (globalThis.navigator as { locks?: unknown }).locks;
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** Document data without an ID: `createPulse` generates one. */
const fresh = () => {
	const { id: _id, ...rest } = data();
	return rest;
};
const create = (scope: PulseScope, connectors: Connector[]) =>
	track(createPulse(Document, fresh(), { scope, connectors, connect: true }));
const sidOf = (pulse: Pulse<any>) => getPulseMeta(pulse).model.sid;
const vectorOf = (pulse: Pulse<any>) => getPulseMeta(pulse).log.vector;
const remote = (relay: PulseRelay) => createMemoryConnector(relay, "remote");
const load = async (scope: PulseScope, id: string, connectors: Connector[]) =>
	track(
		await loadPulse(Document, id, { scope, connectors, waitFor: "synced" }),
	);
const never: Connector = {
	kind: "remote",
	open: () => new Promise(() => {}),
};

describe("reusable actor IDs", () => {
	test("a new page reuses the actor of a closed page and continues its clock", async () => {
		const { page, items } = browser();
		const relay = new PulseRelay();

		const first = page().enter();
		await leaseActor(first.scope, "");
		const created = create(first.scope, [remote(relay)]);
		created.title = "one";
		const actor = sidOf(created);
		expect(actor).toBe(leasedActor(first.scope, "")!);
		expect(JSON.parse(items.get("pulsify:actors:")!)).toEqual([actor]);
		expect(vectorOf(created)).toEqual([[actor, 3]]);
		await connectPulse(created).synced;
		first.close();

		const second = page().enter();
		const loaded = await load(second.scope, created.id, [remote(relay)]);
		expect(loaded.title).toBe("one");
		loaded.title = "two";
		expect(sidOf(loaded)).toBe(actor);
		expect(vectorOf(loaded)).toEqual([[actor, 4]]);

		// The relay accepts the continued sequence and serves it to a third page.
		const third = await load(page().enter().scope, created.id, [remote(relay)]);
		await eventually(() => expect(third.title).toBe("two"));
		expect(vectorOf(third)).toEqual([[actor, 4]]);
		expect(getPulseMeta(loaded).lastError).toBeUndefined();
		third.title = "three";
		expect(sidOf(third)).not.toBe(actor); // The second page is still open.
		expect(JSON.parse(items.get("pulsify:actors:")!)).toEqual([
			actor,
			sidOf(third),
		]);
	});

	test("pages open together hold different actors", async () => {
		const { page, items } = browser();
		const relay = new PulseRelay();
		const first = page().enter();
		await leaseActor(first.scope, "");
		const created = create(first.scope, [remote(relay)]);
		await connectPulse(created).synced;

		const second = page().enter();
		const loaded = await load(second.scope, created.id, [remote(relay)]);
		loaded.title = "two";
		expect(sidOf(loaded)).not.toBe(sidOf(created));
		expect(JSON.parse(items.get("pulsify:actors:")!)).toEqual([
			sidOf(created),
			sidOf(loaded),
		]);
	});

	test("a write before every connector has answered uses a random actor", async () => {
		const { page } = browser();
		const relay = new PulseRelay();
		const seed = create(createPulseScope(), [createMemoryConnector(relay)]);
		await connectPulse(seed).synced;
		const id = seed.id;

		const local: Connector = {
			...createMemoryConnector(relay),
			actorPool: "store",
		};
		const offline = page().enter();
		const loaded = track(
			await loadPulse(Document, id, {
				scope: offline.scope,
				connectors: [local, never],
			}),
		);
		const leased = leasedActor(offline.scope, "store")!;
		expect(leased).toBeGreaterThanOrEqual(65536);
		loaded.title = "offline";
		expect(sidOf(loaded)).not.toBe(leased);

		// The same store alone is a complete history.
		const online = page().enter();
		const again = track(
			await loadPulse(Document, id, {
				scope: online.scope,
				connectors: [local],
			}),
		);
		again.title = "online";
		expect(sidOf(again)).toBe(leasedActor(online.scope, "store")!);
	});

	test("a caller-chosen ID or an unnamed local store is never reused", async () => {
		const { page } = browser();
		const { scope } = page().enter();
		await leaseActor(scope, "");
		const leased = leasedActor(scope, "")!;
		expect(sidOf(track(createPulse(Document, fresh(), { scope })))).toBe(
			leased,
		);
		const chosen = track(createPulse(Document, data("chosen"), { scope }));
		expect(sidOf(chosen)).not.toBe(leased);

		const unnamed = create(scope, [createMemoryConnector()]);
		expect(sidOf(unnamed)).not.toBe(leased);
	});

	test("without Web Locks there is no lease", () => {
		const scope = createPulseScope();
		expect(leaseActor(scope, "")).toBeUndefined();
		expect(leasedActor(scope, "")).toBeUndefined();
	});
});
