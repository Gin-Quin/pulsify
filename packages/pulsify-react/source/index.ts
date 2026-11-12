import {
	getPulseMeta,
	joinPresence,
	loadPulse,
	subscribePulse,
	type AnyPulseDefinition,
	type LoadPulseOptions,
	type ModelFromDefinition,
	type Presence,
	type PresenceDefinition,
	type PresencePeer,
	type Pulse,
} from "pulsify-core";
import {
	defaultPulseOptions,
	RichTextSymbol,
	PulseRefSymbol,
	TreeSymbol,
} from "pulsify-core/bindings";
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";

const Raw = Symbol("Raw");

/**
 * What one component read below one pulse object, array, rich text or tree.
 * The proxy keeps its identity, so memoized children skip, until a value read
 * below it changes. It wraps an empty shell rather than the live value, so
 * frozen values never constrain what the traps return.
 */
class Track implements ProxyHandler<object> {
	readonly target: object;
	readonly proxy: object;
	/** Key → first value read, or the Track of the object read. */
	readonly reads = new Map<string, unknown>();
	present: Map<string, boolean> | undefined;
	own: Map<string, boolean> | undefined;
	keys: string | undefined;
	/** Rich text and tree content, compared as a whole. */
	readonly print: string | undefined;
	stale = false;
	/** The previous generation, whose unchanged children are reused lazily. */
	private previous: Track | undefined;
	private byTarget: Map<object, Track> | undefined;
	constructor(target: object, previous: Track | undefined) {
		this.target = target;
		this.print = print(target);
		this.proxy = new Proxy(Array.isArray(target) ? [] : {}, this);
		this.previous = previous;
		if (previous) previous.previous = undefined;
	}
	get(_shell: object, key: string | symbol): unknown {
		const target = this.target;
		if (key === Raw) return target;
		const value: unknown = Reflect.get(target, key);
		if (
			this.print !== undefined ||
			typeof key === "symbol" ||
			typeof value === "function"
		)
			return value;
		const read = this.reads.get(key);
		if (!trackable(value)) {
			// The first read stays the baseline, so a change mid-render is seen.
			if (!this.reads.has(key)) this.reads.set(key, value);
			return value;
		}
		if (read instanceof Track && read.target === value) return read.proxy;
		if (this.reads.has(key)) return new Track(value, undefined).proxy;
		const child = this.child(key, value);
		this.reads.set(key, child);
		return child.proxy;
	}
	private child(key: string, value: object): Track {
		const old = this.previous?.reads.get(key);
		if (old instanceof Track && old.target === value)
			return old.stale ? new Track(value, old) : old;
		// A moved array element keeps its Track if nothing it read changed.
		if (this.previous && Array.isArray(this.target)) {
			const moved = this.previous.tracks().get(value);
			if (moved) return changed(moved) ? new Track(value, moved) : moved;
		}
		return new Track(value, undefined);
	}
	private tracks(): Map<object, Track> {
		if (!this.byTarget) {
			this.byTarget = new Map();
			for (const read of this.reads.values())
				if (read instanceof Track) this.byTarget.set(read.target, read);
		}
		return this.byTarget;
	}
	has(_shell: object, key: string | symbol): boolean {
		const result = Reflect.has(this.target, key);
		if (this.print === undefined && typeof key === "string") {
			this.present ??= new Map();
			if (!this.present.has(key)) this.present.set(key, result);
		}
		return result;
	}
	getOwnPropertyDescriptor(
		_shell: object,
		key: string | symbol,
	): PropertyDescriptor | undefined {
		const target = this.target;
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (this.print === undefined && typeof key === "string") {
			this.own ??= new Map();
			if (!this.own.has(key)) this.own.set(key, descriptor !== undefined);
		}
		if (!descriptor) return undefined;
		// Only the array shell's length exists, and it is writable.
		if (key === "length" && Array.isArray(target))
			return { ...descriptor, writable: true };
		return { ...descriptor, configurable: true };
	}
	ownKeys(): ArrayLike<string | symbol> {
		const keys = Reflect.ownKeys(this.target);
		if (this.print === undefined) this.keys ??= keys.join("\0");
		return keys;
	}
	set(_shell: object, key: string | symbol, value: unknown): boolean {
		return Reflect.set(this.target, key, unwrap(value));
	}
	deleteProperty(_shell: object, key: string | symbol): boolean {
		return Reflect.deleteProperty(this.target, key);
	}
	defineProperty(
		_shell: object,
		key: string | symbol,
		descriptor: PropertyDescriptor,
	): boolean {
		return Reflect.defineProperty(this.target, key, descriptor);
	}
	preventExtensions(): boolean {
		return false;
	}
}

function trackable(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		(Array.isArray(value) ||
			Reflect.get(value, Symbol.toStringTag) === "PulseObject" ||
			Reflect.get(value, RichTextSymbol) === true ||
			Reflect.get(value, TreeSymbol) === true)
	);
}

// ponytail: O(content) per check; a per-node revision in the core would make it O(1).
function print(value: any): string | undefined {
	if (value[RichTextSymbol]) return JSON.stringify(value.toDelta());
	if (value[TreeSymbol]) return JSON.stringify(value.toJSON());
	return undefined;
}

function unwrap(value: unknown): unknown {
	return typeof value === "object" && value !== null
		? (Reflect.get(value, Raw) ?? value)
		: value;
}

/**
 * Re-read every recorded path on the live pulse and mark changed Tracks stale.
 * Never stops at the first change: a Track left fresh is reused as is.
 */
// ponytail: O(reads) per change; walk only changed CoreNodes if large trees need it.
function changed(track: Track): boolean {
	const target = track.target;
	let dirty =
		track.print !== undefined
			? track.print !== print(target)
			: track.keys !== undefined &&
				track.keys !== Reflect.ownKeys(target).join("\0");
	for (const [key, read] of track.reads) {
		const value: unknown = Reflect.get(target, key);
		// A Track found elsewhere, after a move, is checked when it is reused.
		if (read instanceof Track) {
			if (read.target !== value || changed(read)) dirty = true;
		} else if (!same(read, value)) dirty = true;
	}
	if (track.present)
		for (const [key, result] of track.present)
			if (Reflect.has(target, key) !== result) dirty = true;
	if (track.own)
		for (const [key, result] of track.own)
			if (
				(Reflect.getOwnPropertyDescriptor(target, key) !== undefined) !==
				result
			)
				dirty = true;
	if (dirty) track.stale = true;
	return dirty;
}

function same(read: any, value: any): boolean {
	if (typeof read !== "object" || read === null) return Object.is(read, value);
	// Sub-pulse handles and bytes are fresh objects on every read.
	if (read[PulseRefSymbol])
		return value?.[PulseRefSymbol] === true && read.id === value.id;
	if (read instanceof Uint8Array)
		return (
			value instanceof Uint8Array &&
			read.length === value.length &&
			read.every((byte, i) => byte === value[i])
		);
	return read === value;
}

function clientOnly(): never {
	throw new Error(
		"usePulse renders on the client only; wrap it in <Suspense> for server rendering",
	);
}

/**
 * Read a pulse during render and re-render only when a value this component,
 * or a child it passed a value to, read has changed. Objects and arrays keep
 * their identity while nothing read below them changes, so `memo` children
 * skip. Writes go through to the pulse.
 *
 * Pulses live on the client only: during server rendering and hydration, the
 * nearest `<Suspense>` boundary shows its fallback and renders on the client.
 */
export function usePulse<P extends Pulse<any>>(input: P): P {
	const pulse = unwrap(input) as P;
	const [owner] = useState(() => ({
		root: undefined as Track | undefined,
		version: 0,
		changes: 0,
		notify: undefined as (() => void) | undefined,
	}));
	const subscribe = useCallback(
		(notify: () => void) => {
			owner.notify = notify;
			return subscribePulse(pulse, () => {
				owner.changes++;
				if (owner.root && changed(owner.root)) {
					owner.version++;
					notify();
				}
			});
		},
		[pulse, owner],
	);
	const version = () => owner.version;
	useSyncExternalStore(subscribe, version, clientOnly);
	const changes = owner.changes;
	// The root is renewed on every render, so it only holds this render's reads.
	const root = new Track(pulse, owner.root);
	useLayoutEffect(() => {
		owner.root = root;
		// A change during a concurrent render may be shown by part of the tree.
		if (owner.changes !== changes && changed(root)) {
			owner.version++;
			owner.notify?.();
		}
	});
	return root.proxy as P;
}

/** Loads in flight, by ID, so a suspended component finds its promise again. */
// ponytail: keyed by ID only, as the default scope is; key by scope too if apps load one ID in several scopes.
const loads = new Map<string, { promise: Promise<void>; error?: unknown }>();
const subscribeNothing = () => () => {};
const onClient = () => true;

/**
 * Load a pulse, suspend until it is loaded, then return it as `usePulse`
 * does. A pulse loaded or created already in the scope is returned at once.
 * A failed load throws to the nearest error boundary and starts again on the
 * next render.
 *
 * Never loads on the server: the nearest `<Suspense>` boundary shows its
 * fallback and renders on the client.
 */
export function useLoadPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	options?: LoadPulseOptions,
): Pulse<ModelFromDefinition<Definition>> {
	useSyncExternalStore(subscribeNothing, onClient, clientOnly);
	const scope = options?.scope ?? defaultPulseOptions.scope;
	const loaded = scope.pulses.get(id);
	if (loaded && getPulseMeta(loaded).loaded)
		return usePulse(loaded as Pulse<ModelFromDefinition<Definition>>);
	let load = loads.get(id);
	if (!load) {
		const entry: { promise: Promise<void>; error?: unknown } = {
			promise: loadPulse(definition, id, options).then(
				() => void loads.delete(id),
				(error) => void (entry.error = error ?? new Error("loadPulse failed")),
			),
		};
		loads.set(id, (load = entry));
	}
	if (load.error !== undefined) {
		loads.delete(id);
		throw load.error;
	}
	throw load.promise;
}

const NOBODY: readonly never[] = Object.freeze([]);

/** What `usePulsePresence` returns: one presence channel of a pulse. */
export type PulsePresence<State> = {
	/** Everyone else in the channel. Unchanged peers keep the same object. */
	readonly others: readonly PresencePeer<State>[];
	/** What this session last set, or undefined. */
	readonly mine: State | undefined;
	/**
	 * Publish this session's state; undefined removes it. Never call it during
	 * render. It keeps its identity while the pulse and the channel are the same.
	 */
	readonly set: (state: State | undefined) => void;
};

/**
 * Join a presence channel of a pulse while the component is mounted, and
 * re-render when the others or this session's own state change. Joins are
 * counted, so several components can share a channel.
 *
 * Presence lives on the client only: during server rendering and hydration,
 * the nearest `<Suspense>` boundary shows its fallback, as with `usePulse`.
 */
export function usePulsePresence<State>(
	input: Pulse<any>,
	definition: PresenceDefinition<State>,
): PulsePresence<State> {
	const pulse = unwrap(input) as Pulse<any>;
	// One slot per pulse and channel: after a switch, nothing of the previous
	// channel is shown, and `set` cannot publish into it.
	const slot = useMemo(
		() => ({
			pulse,
			definition,
			handle: undefined as Presence<State> | undefined,
			version: 0,
			/** A state set before the channel is joined, by a child's effect. */
			pending: undefined as { state: State | undefined } | undefined,
			others: NOBODY as readonly PresencePeer<State>[],
			mine: undefined as State | undefined,
		}),
		[pulse, definition],
	);
	const subscribe = useCallback(
		(notify: () => void) => {
			const handle = joinPresence(slot.pulse, slot.definition);
			slot.handle = handle;
			if (slot.pending) handle.set(slot.pending.state);
			slot.pending = undefined;
			let listening = false;
			handle.subscribe(() => {
				if (!listening) return;
				slot.version++;
				notify();
			});
			listening = true;
			// The render that precedes the join saw nothing: show what is there.
			if (
				handle.mine !== slot.mine ||
				(handle.others !== slot.others &&
					handle.others.length + slot.others.length > 0)
			)
				slot.version++;
			return () => {
				listening = false;
				if (slot.handle === handle) slot.handle = undefined;
				handle.leave();
			};
		},
		[slot],
	);
	useSyncExternalStore(subscribe, () => slot.version, clientOnly);
	const set = useCallback(
		(state: State | undefined) => {
			if (slot.handle) slot.handle.set(state);
			else slot.pending = { state };
		},
		[slot],
	);
	slot.others = slot.handle?.others ?? NOBODY;
	slot.mine = slot.handle?.mine;
	return { others: slot.others, mine: slot.mine, set };
}
