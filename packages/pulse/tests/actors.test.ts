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
import { leaseActor, leasedActor, ownActors } from "../source/pulses/actors";
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
	const page = (identity?: string) => {
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
			scope: createPulseScope(identity === undefined ? {} : { identity }),
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

/**
 * A remote connector that records the actors its sessions are told about,
 * and refuses those of `taken`, as an endpoint that holds them for another
 * account does.
 */
function declaring(relay: PulseRelay, taken = new Set<number>()) {
	const inner = createMemoryConnector(relay, "remote");
	const declared: number[] = [];
	const identities: (string | undefined)[] = [];
	const connector: Connector = {
		...inner,
		async open(input) {
			identities.push(input.identity);
			return {
				...(await inner.open(input)),
				declareActors(actors) {
					declared.push(...actors);
					const refused = actors.filter((actor) => taken.has(actor));
					if (refused.length)
						queueMicrotask(() => input.onActorsRefused?.(refused));
				},
			};
		},
	};
	return { connector, declared, identities, taken };
}

describe("actors of an account", () => {
	test("two accounts of one browser profile never share an actor", async () => {
		const { page, items } = browser();
		const relay = new PulseRelay();
		const alice = page("alice").enter();
		await leaseActor(alice.scope, "");
		const created = create(alice.scope, [remote(relay)]);
		await connectPulse(created).synced;
		const actor = sidOf(created);
		alice.close();

		// The actor of Alice's closed page is free, and not Bob's to take.
		const bob = page("bob").enter();
		const loaded = await load(bob.scope, created.id, [remote(relay)]);
		loaded.title = "bob";
		expect(sidOf(loaded)).not.toBe(actor);
		expect(JSON.parse(items.get('pulsify:actors:["alice",""]')!)).toEqual([
			actor,
		]);
		expect(JSON.parse(items.get('pulsify:actors:["bob",""]')!)).toEqual([
			sidOf(loaded),
		]);
		expect([...ownActors(alice.scope)]).toEqual([actor]);
		expect([...ownActors(bob.scope)]).toEqual([sidOf(loaded)]);
		bob.close();

		// Alice again: her actor, and its sequence, continue.
		const again = page("alice").enter();
		const back = await load(again.scope, created.id, [remote(relay)]);
		back.title = "alice";
		expect(sidOf(back)).toBe(actor);
		expect(() => createPulseScope({ identity: "" })).toThrow(TypeError);
	});

	test("a write made offline is declared by a later page of the same account, and by no other", async () => {
		const { page } = browser();
		const server = new PulseRelay(),
			store = new PulseRelay();
		const seed = create(createPulseScope(), [
			createMemoryConnector(store),
			remote(server),
		]);
		await connectPulse(seed).synced;
		const local: Connector = {
			...createMemoryConnector(store),
			actorPool: "store",
		};

		// Offline: a one-off actor, different for each document, kept by the
		// local store with its rows when the page closes.
		const offline = page("alice").enter();
		const first = track(
			await loadPulse(Document, seed.id, {
				scope: offline.scope,
				connectors: [local, never],
			}),
		);
		first.title = "offline";
		const other = create(offline.scope, [local, never]);
		const actor = sidOf(first);
		expect(actor).not.toBe(leasedActor(offline.scope, "store")!);
		expect(sidOf(other)).not.toBe(actor);
		// The store has the write before the page closes.
		await eventually(() =>
			expect(getPulseMeta(first).connections[0]!.clockVector).toEqual(
				vectorOf(first),
			),
		);
		destroyPulse(first);
		offline.close();

		// Another account on the same profile uploads these rows: it relays
		// them, and says nothing of their actor.
		const bob = page("bob").enter();
		const relayed = declaring(server);
		const theirs = track(
			await loadPulse(Document, seed.id, {
				scope: bob.scope,
				connectors: [local, relayed.connector],
				waitFor: "synced",
			}),
		);
		expect(theirs.title).toBe("offline");
		expect(relayed.identities).toEqual(["bob"]);
		// Its own leased actor, when it connects: nothing of Alice's.
		const bobs = leasedActor(bob.scope, "store")!;
		expect(relayed.declared).toEqual([bobs]);
		theirs.title = "bob";
		expect(sidOf(theirs)).toBe(bobs);
		await eventually(() => expect(relayed.declared).toEqual([bobs, bobs]));
		destroyPulse(theirs);
		bob.close();

		// The same account, later: the actor of its earlier page is its own.
		const later = page("alice").enter();
		expect(ownActors(later.scope).has(actor)).toBe(true);
		expect(ownActors(later.scope).has(sidOf(other))).toBe(true);
		const blank = new PulseRelay();
		const own = declaring(blank);
		track(
			await loadPulse(Document, seed.id, {
				scope: later.scope,
				connectors: [local, own.connector],
				waitFor: "synced",
			}),
		);
		// What it uploads to a server that has nothing: the seed's rows and
		// Bob's, relayed, and its own, declared after its leased actor.
		expect(own.declared).toEqual([leasedActor(later.scope, "store")!, actor]);
	});

	test("without an identity, a later page claims nothing an earlier page wrote", async () => {
		const { page, items } = browser();
		const server = new PulseRelay(),
			store = new PulseRelay();
		const seed = create(createPulseScope(), [
			createMemoryConnector(store),
			remote(server),
		]);
		await connectPulse(seed).synced;
		const local: Connector = {
			...createMemoryConnector(store),
			actorPool: "store",
		};
		// One account writes offline and leaves; another signs in on the
		// same profile. Nothing says whose the stored actor was.
		const first = page().enter();
		const written = track(
			await loadPulse(Document, seed.id, {
				scope: first.scope,
				connectors: [local, never],
			}),
		);
		written.title = "offline";
		const actor = sidOf(written);
		await eventually(() =>
			expect(getPulseMeta(written).connections[0]!.clockVector).toEqual(
				vectorOf(written),
			),
		);
		destroyPulse(written);
		first.close();
		expect(
			[...items.keys()].filter((key) => key.startsWith("pulsify:own")),
		).toEqual([]);

		const second = page().enter();
		const uploaded = declaring(server);
		const loaded = track(
			await loadPulse(Document, seed.id, {
				scope: second.scope,
				connectors: [local, uploaded.connector],
				waitFor: "synced",
			}),
		);
		expect(loaded.title).toBe("offline");
		expect(uploaded.declared).not.toContain(actor);
		expect(ownActors(second.scope).has(actor)).toBe(false);
	});

	test("an actor that an endpoint holds for another account is never written under", async () => {
		const { page } = browser();
		const relay = new PulseRelay();
		// Two accounts share a profile, and so its actors, without identities.
		const alice = page().enter();
		await leaseActor(alice.scope, "");
		const created = create(alice.scope, [remote(relay)]);
		await connectPulse(created).synced;
		const actor = sidOf(created);
		alice.close();

		const bob = page().enter();
		const errors: Error[] = [];
		const endpoint = declaring(relay, new Set([actor]));
		const loaded = track(
			await loadPulse(Document, created.id, {
				scope: bob.scope,
				connectors: [endpoint.connector],
				waitFor: "synced",
				onError: (error) => errors.push(error),
			}),
		);
		// Bob's page leased Alice's actor, and learns it is hers as it connects.
		expect(leasedActor(bob.scope, "")).toBe(actor);
		expect(endpoint.declared).toEqual([actor]);
		await eventually(() => expect(errors).toHaveLength(1));
		expect(errors[0]).toMatchObject({ code: "FORBIDDEN" });
		loaded.title = "bob";
		const bobs = sidOf(loaded);
		expect(bobs).not.toBe(actor);
		await eventually(() => expect(endpoint.declared).toEqual([actor, bobs]));
		expect(vectorOf(loaded)).toContainEqual([actor, 2]);

		// An actor refused while in use: what it wrote stays, the next write
		// is under another one, and no sequence forks.
		endpoint.taken.add(bobs);
		const connection = getPulseMeta(loaded).connections[0]!;
		connection.close();
		connection.start();
		loaded.title = "bob again";
		expect(sidOf(loaded)).toBe(bobs);
		await eventually(() => expect(connection.refused.has(bobs)).toBe(true));
		loaded.title = "bob, elsewhere";
		const next = sidOf(loaded);
		expect(next).not.toBe(bobs);
		expect(next).not.toBe(actor);
		expect(errors).toHaveLength(2);
		await eventually(() => expect(created.title).toBe("bob, elsewhere"));
		expect(getPulseMeta(loaded).lastError).toBe(errors[1]);
	});

	test("a pulse that never writes, or never synchronizes, declares and keeps nothing", async () => {
		const { page, items } = browser();
		const relay = new PulseRelay();
		const seed = create(createPulseScope(), [remote(relay)]);
		await connectPulse(seed).synced;
		const reader = page("rita").enter();
		const remoteConnector = declaring(relay);
		await load(reader.scope, seed.id, [remoteConnector.connector]);
		track(createPulse(Document, fresh(), { scope: reader.scope }));
		// Its leased actor as it connects, which it never wrote with.
		expect(remoteConnector.declared).toEqual([leasedActor(reader.scope, "")!]);
		expect(items.has("pulsify:own:rita")).toBe(false);
		expect([...ownActors(reader.scope)]).toEqual([]);
	});
});
