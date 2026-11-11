import type { Connector } from "../connection/Connector.js";
import type { PulseScope } from "./PulseOptions.js";

/**
 * Reusable actor IDs. A scope leases one ID per pool for the life of its page.
 * A pool's IDs are listed in localStorage, and the holder of an ID keeps a Web
 * Lock, which the browser releases when the page goes away, crashes included.
 * Without Web Locks or localStorage there is no lease and actors stay random.
 */
type Lease = { id?: number; pending?: Promise<void> };
type Environment = { locks: LockManager; storage: Storage };

/** A stuck page holding the list must not keep documents from loading. */
const LEASE_TIMEOUT_MS = 1000;
const leases = new WeakMap<PulseScope, Map<string, Lease>>();

export function randomActor(): number {
	const bytes = crypto.getRandomValues(new Uint32Array(2));
	return 65536 + bytes[0]! * 1048576 + (bytes[1]! & 0xfffff);
}

/**
 * The pool a pulse leases from: its local store's, or the page-wide pool
 * without a local connector. `undefined` (no reuse) when a local connector
 * names no pool or two of them disagree, since no single store has then seen
 * every row of the pool's actors.
 */
export function actorPoolOf(
	connectors: readonly Connector[],
): string | undefined {
	const pools = new Set(
		connectors
			.filter((connector) => connector.kind === "local")
			.map((connector) => connector.actorPool),
	);
	if (!pools.size) return "";
	return pools.size === 1 ? [...pools][0] : undefined;
}

function environment(): Environment | undefined {
	try {
		const locks = globalThis.navigator?.locks;
		const storage = globalThis.localStorage;
		return locks && storage ? { locks, storage } : undefined;
	} catch {
		return undefined; // Blocked storage throws on access.
	}
}

/** Take the lock if it is free and keep it until the page goes away. */
const hold = (locks: LockManager, name: string) =>
	new Promise<boolean>((resolve, reject) => {
		locks
			.request(name, { ifAvailable: true }, (lock) => {
				resolve(lock !== null);
				return lock ? new Promise<never>(() => {}) : undefined;
			})
			.catch(reject);
	});

async function acquire(
	pool: string,
	{ locks, storage }: Environment,
): Promise<number | undefined> {
	const key = `pulsify:actors:${pool}`;
	const lockOf = (id: number) => `pulsify:actor:${pool}:${id}`;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), LEASE_TIMEOUT_MS);
	try {
		// One page at a time reads and extends the list.
		return await locks.request(key, { signal: timeout.signal }, async () => {
			clearTimeout(timer);
			let ids: number[] = [];
			try {
				const stored: unknown = JSON.parse(storage.getItem(key) ?? "[]");
				if (Array.isArray(stored))
					ids = stored.filter((id) => Number.isSafeInteger(id) && id >= 65536);
			} catch {
				/* An unreadable list starts over: its IDs are simply never reused. */
			}
			for (const id of ids) if (await hold(locks, lockOf(id))) return id;
			const id = randomActor();
			storage.setItem(key, JSON.stringify([...ids, id]));
			return (await hold(locks, lockOf(id))) ? id : undefined;
		});
	} catch {
		return undefined; // Full or blocked storage, an opaque origin, a stuck page.
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Start leasing the scope's actor for a pool, once. Returns a promise while
 * the lease is being acquired, `undefined` once it is settled or unsupported.
 */
export function leaseActor(
	scope: PulseScope,
	pool: string | undefined,
): Promise<void> | undefined {
	if (pool === undefined) return undefined;
	let pools = leases.get(scope);
	let lease = pools?.get(pool);
	if (!lease) {
		const available = environment();
		if (!available) return undefined;
		const created: Lease = {};
		created.pending = acquire(pool, available).then((id) => {
			if (id !== undefined) created.id = id;
			delete created.pending;
		});
		if (!pools) leases.set(scope, (pools = new Map()));
		// ponytail: a discarded scope keeps its lock until the page closes;
		// release it from a FinalizationRegistry if scopes become short-lived.
		pools.set(pool, (lease = created));
	}
	return lease.pending;
}

/** The scope's leased actor for a pool, once acquired. */
export function leasedActor(
	scope: PulseScope,
	pool: string | undefined,
): number | undefined {
	return pool === undefined ? undefined : leases.get(scope)?.get(pool)?.id;
}
