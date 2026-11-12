import {
	object,
	type Codec,
	type InferType,
	type Schema,
} from "@gin-quin/codec";
import type { Connection } from "../connection/Connection.js";
import {
	compilePulseSchema,
	schemaFingerprint,
	type PulseLayout,
} from "../core/schema.js";
import { asPulseError, PulseError } from "../protocol/errors.js";
import {
	decodePresenceFrame,
	encodePresenceFrame,
	MAX_PRESENCE_BYTES,
	MAX_PRESENCE_NAME,
	PresenceEvent,
} from "../protocol/presenceFrames.js";
import type { Pulse } from "../pulses/Pulse.js";
import { type PulseMeta, PulseMetaSymbol } from "../pulses/PulseMeta.js";

/** A named, typed channel of live state. Create it with `definePresence`. */
export type PresenceDefinition<State = unknown> = {
	readonly name: string;
	readonly schema: Schema;
	/** At most one update is sent per interval. */
	readonly throttleMs: number;
	/** What peers must share to see each other: the name and the schema layout. */
	readonly key: string;
	readonly codec: Codec<State>;
	/** Validate a state before it is encoded. */
	readonly assert: (value: unknown) => State;
};

/** The state one other connected session published in a channel. */
export type PresencePeer<State> = {
	/** One connected session: a tab, a window, a device. Given by the relay. */
	readonly peer: number;
	/** Who the relay authenticated, when it did. */
	readonly subject?: string;
	readonly state: State;
};

/** One channel of one pulse, as returned by `joinPresence`. */
export type Presence<State> = {
	/** Everyone else in the channel. A new array only when something changed. */
	readonly others: readonly PresencePeer<State>[];
	/** What I last set, or undefined. */
	readonly mine: State | undefined;
	/** Publish my state; undefined removes it. */
	set(state: State | undefined): void;
	/**
	 * Called now, then synchronously after every change, and a last time when
	 * this holder leaves. Returns the function that stops it.
	 */
	subscribe(listener: (presence: Presence<State>) => void): () => void;
	/** Undo this joinPresence. The channel closes with its last holder. */
	leave(): void;
};

/** The fewest bytes a value of this layout can encode to. */
function minimumBytes(
	layout: PulseLayout,
	visiting = new Set<PulseLayout>(),
): number {
	switch (layout.kind) {
		case "null":
		case "undefined":
		case "literal":
			return 0;
		case "object":
		case "tuple": {
			// A recursive schema: count nothing for the cycle.
			if (visiting.has(layout)) return 0;
			visiting.add(layout);
			let bytes = 0;
			for (const field of layout.fields)
				bytes += minimumBytes(field.layout, visiting);
			for (const element of layout.elements ?? [])
				bytes += minimumBytes(element, visiting);
			visiting.delete(layout);
			return bytes;
		}
		default:
			// A length, a tag, a presence byte or at least one byte of data.
			return 1;
	}
}

/**
 * Any reader can publish presence, so a state must not decode to more than
 * its 16 KiB can describe. The codec stops at the end of the bytes, which
 * bounds every collection except one whose elements take no bytes at all:
 * a few bytes of length would then decode to millions of elements.
 */
function assertBounded(layouts: readonly PulseLayout[]): void {
	for (const layout of layouts)
		if (
			(layout.kind === "array" || layout.kind === "set") &&
			layout.element &&
			minimumBytes(layout.element) === 0
		)
			throw new TypeError(
				"A presence schema cannot hold an array or set of values that take no bytes (null, undefined, a literal, an empty object or tuple): give its elements a field",
			);
}

/**
 * Define a channel of presence: live state that every connected peer
 * publishes for itself, shared with everyone subscribed to a pulse and never
 * stored. Peers see each other in a channel when its name and schema match.
 */
export function definePresence<S extends Schema>(
	name: string,
	schema: S,
	options: { throttleMs?: number } = {},
): PresenceDefinition<InferType<S>> {
	const throttleMs = options.throttleMs ?? 50;
	if (typeof name !== "string" || !name.length || !name.isWellFormed())
		throw new TypeError("A presence channel needs a name");
	if (!Number.isFinite(throttleMs) || throttleMs < 0)
		throw new TypeError("throttleMs must be a non-negative number");
	const compiled = compilePulseSchema(schema);
	assertBounded(compiled.layouts);
	// Peers with another layout must not decode each other's bytes.
	const key = `${name}#${schemaFingerprint(compiled).slice(0, 8)}`;
	if (key.length > MAX_PRESENCE_NAME)
		throw new TypeError("The presence channel name is too long");
	return Object.freeze({
		name,
		schema,
		throttleMs,
		key,
		codec: compiled.codec,
		assert: (value: unknown) => compiled.assert(value),
	});
}

/**
 * The selection each peer has in a `richText()` field of a pulse, as the
 * editor bindings share it: two anchors from `anchorAt`, which name their
 * field, and how to show their owner. An empty name or color means none.
 */
export const RichTextSelection: PresenceDefinition<{
	anchor: string;
	head: string;
	name: string;
	color: string;
}> = definePresence(
	"rich-text-selection",
	object({
		anchor: "string",
		head: "string",
		name: "string",
		color: "string",
	}),
);

type Entry = PresencePeer<unknown>;
/** The bytes each entry was decoded from, to recognize the same state again. */
const encoded = new WeakMap<Entry, Uint8Array>();
type Channel = {
	readonly definition: PresenceDefinition<any>;
	holders: number;
	mine: unknown;
	mineBytes: Uint8Array | undefined;
	/** What the relay reported, by peer. */
	readonly remote: Map<number, Entry>;
	/** Cached until a peer changes, so readers can compare by identity. */
	others: readonly PresencePeer<unknown>[] | undefined;
	readonly listeners: Set<() => void>;
	timer: ReturnType<typeof setTimeout> | undefined;
	lastSent: number;
	/** The other peers were sent a state and no clear since. */
	published: boolean;
};
/** The presence of one pulse: its channels, fed by the pulse's connections. */
export type PresenceHub = {
	readonly channels: Map<string, Channel>;
	/**
	 * The one connection presence goes through: peer numbers belong to a
	 * relay, so the peers of two relays cannot be told apart or merged.
	 */
	connection: Connection | undefined;
	/** Send to the relay in use, choosing one if none is. */
	send(bytes: Uint8Array): void;
	receive(connection: Connection, bytes: Uint8Array): void;
	dispose(): void;
};

const EMPTY: readonly never[] = Object.freeze([]);
const NO_STATE = new Uint8Array();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function createHub(meta: PulseMeta): PresenceHub {
	const channels = new Map<string, Channel>();
	const frame = (channel: Channel, event: PresenceEvent, to = 0): Uint8Array =>
		encodePresenceFrame({
			docId: meta.id,
			peer: 0,
			to,
			event,
			subject: "",
			channel: channel.definition.key,
			state:
				event === PresenceEvent.state
					? (channel.mineBytes ?? NO_STATE)
					: NO_STATE,
		});
	const changed = (channel: Channel) => {
		channel.others = undefined;
		for (const listener of [...channel.listeners]) {
			try {
				listener();
			} catch (error) {
				meta.report(asPulseError(error));
			}
		}
	};
	/**
	 * Use the first connection, in connector order, whose session relays
	 * presence: ask its peers for their state and give them mine. It is kept
	 * until it fails, then the next one takes over.
	 */
	const choose = () => {
		if (hub.connection) return;
		const next = meta.connections.find(
			(connection) => connection.relaysPresence,
		);
		if (!next) return;
		hub.connection = next;
		for (const channel of channels.values()) {
			next.sendPresence(frame(channel, PresenceEvent.join));
			if (channel.mineBytes)
				next.sendPresence(frame(channel, PresenceEvent.state));
			channel.published = !!channel.mineBytes;
		}
	};
	/** A lost session takes its peers with it: they are new peers next time. */
	const drop = (connection: Connection) => {
		if (hub.connection !== connection) return;
		hub.connection = undefined;
		for (const channel of channels.values()) {
			channel.published = false;
			if (channel.remote.size) {
				channel.remote.clear();
				changed(channel);
			}
		}
		choose();
	};
	const stops = meta.connections.flatMap((connection) => [
		connection.on("connected", choose),
		connection.on("error", () => drop(connection)),
		connection.on("closed", () => drop(connection)),
	]);
	const hub: PresenceHub = {
		channels,
		connection: undefined,
		send(bytes) {
			// Choosing a connection announces every channel, this frame included.
			if (hub.connection) hub.connection.sendPresence(bytes);
			else choose();
		},
		receive(connection, bytes) {
			if (connection !== hub.connection) return;
			let received;
			try {
				received = decodePresenceFrame(bytes);
			} catch {
				return; // Presence never breaks the synchronization of the document.
			}
			const { peer, event, subject } = received;
			if (received.docId !== meta.id || peer < 1) return;
			if (event === PresenceEvent.leave) {
				for (const channel of channels.values())
					if (channel.remote.delete(peer)) changed(channel);
				return;
			}
			const channel = channels.get(received.channel);
			if (!channel) return;
			if (event === PresenceEvent.join) {
				// A newcomer: only it needs what everyone else already has.
				if (channel.mineBytes)
					connection.sendPresence(frame(channel, PresenceEvent.state, peer));
				return;
			}
			if (event === PresenceEvent.clear) {
				if (channel.remote.delete(peer)) changed(channel);
				return;
			}
			const previous = channel.remote.get(peer);
			if (
				previous &&
				(previous.subject ?? "") === subject &&
				sameBytes(encoded.get(previous) ?? NO_STATE, received.state)
			)
				return; // The same state again: its object keeps its identity.
			let state: unknown;
			try {
				state = channel.definition.codec.decode(received.state);
			} catch {
				return;
			}
			const entry: Entry = Object.freeze({
				peer,
				...(subject ? { subject } : {}),
				state,
			});
			encoded.set(entry, received.state);
			channel.remote.set(peer, entry);
			changed(channel);
		},
		dispose() {
			for (const stop of stops) stop();
			for (const channel of channels.values()) {
				clearTimeout(channel.timer);
				channel.holders = 0;
				channel.mine = channel.mineBytes = undefined;
				channel.remote.clear();
				changed(channel);
				channel.listeners.clear();
			}
			channels.clear();
			hub.connection = undefined;
			meta.presence = undefined;
		},
	};
	return hub;
}

/**
 * Join a presence channel of a pulse: publish a state for yourself with `set`
 * and read the state of every other connected peer in `others`. Works on any
 * pulse, connected or not; while offline `others` is empty and your state is
 * kept, then sent when a connection that relays presence is established.
 *
 * Each call is undone by its own `leave()`; the channel closes with the last
 * one, and `destroyPulse` closes them all.
 */
export function joinPresence<State>(
	pulse: Pulse<any>,
	definition: PresenceDefinition<State>,
): Presence<State> {
	const meta = pulse[PulseMetaSymbol];
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	const hub = (meta.presence ??= createHub(meta));
	const send = (bytes: Uint8Array) => hub.send(bytes);
	const encode = (
		event: PresenceEvent,
		state: Uint8Array = NO_STATE,
	): Uint8Array =>
		encodePresenceFrame({
			docId: meta.id,
			peer: 0,
			to: 0,
			event,
			subject: "",
			channel: definition.key,
			state,
		});
	let channel = hub.channels.get(definition.key);
	if (!channel) {
		channel = {
			definition,
			holders: 0,
			mine: undefined,
			mineBytes: undefined,
			remote: new Map(),
			others: undefined,
			listeners: new Set(),
			timer: undefined,
			lastSent: -Infinity,
			published: false,
		};
		hub.channels.set(definition.key, channel);
		send(encode(PresenceEvent.join));
	}
	const joined = channel;
	joined.holders++;
	let left = false;
	/** This holder's listeners, removed when it leaves. */
	const subscriptions = new Set<() => void>();
	const open = () => !left && joined.holders > 0;
	const flush = () => {
		joined.timer = undefined;
		if (!joined.holders) return;
		joined.lastSent = Date.now();
		joined.published = !!joined.mineBytes && !!hub.connection;
		send(
			joined.mineBytes
				? encode(PresenceEvent.state, joined.mineBytes)
				: encode(PresenceEvent.clear),
		);
	};
	const presence: Presence<State> = {
		get others() {
			if (!open()) return EMPTY;
			if (!joined.others) {
				joined.others = joined.remote.size
					? Object.freeze([...joined.remote.values()])
					: EMPTY;
			}
			return joined.others as readonly PresencePeer<State>[];
		},
		get mine() {
			return open() ? (joined.mine as State | undefined) : undefined;
		},
		set(state) {
			if (!open()) return;
			let bytes: Uint8Array | undefined;
			if (state !== undefined) {
				bytes = definition.codec.encode(definition.assert(state));
				if (bytes.length > MAX_PRESENCE_BYTES)
					throw new PulseError(
						"LIMIT_EXCEEDED",
						"Presence state exceeds 16 KiB",
					);
			}
			if (
				bytes === undefined
					? joined.mineBytes === undefined
					: joined.mineBytes && sameBytes(bytes, joined.mineBytes)
			)
				return;
			joined.mineBytes = bytes;
			// A detached copy, as the other peers will decode it.
			joined.mine = bytes && definition.codec.decode(bytes);
			// The first state leaves at once, then the latest one per interval.
			const wait = joined.lastSent + definition.throttleMs - Date.now();
			if (wait <= 0) {
				clearTimeout(joined.timer);
				flush();
			} else joined.timer ??= setTimeout(flush, wait);
			for (const listener of [...joined.listeners]) {
				try {
					listener();
				} catch (error) {
					meta.report(asPulseError(error));
				}
			}
		},
		subscribe(listener) {
			if (!open()) return () => {};
			const wrapped = () => listener(presence);
			const stop = () => {
				subscriptions.delete(wrapped);
				joined.listeners.delete(wrapped);
			};
			subscriptions.add(wrapped);
			joined.listeners.add(wrapped);
			try {
				wrapped();
			} catch (error) {
				stop();
				throw error;
			}
			return stop;
		},
		leave() {
			if (left) return;
			left = true;
			const last = [...subscriptions];
			for (const listener of subscriptions) joined.listeners.delete(listener);
			subscriptions.clear();
			if (joined.holders && !--joined.holders) {
				clearTimeout(joined.timer);
				// Also when a clear was still waiting for its throttle interval.
				if (joined.published) send(encode(PresenceEvent.clear));
				joined.mine = joined.mineBytes = undefined;
				joined.remote.clear();
				joined.listeners.clear();
				if (hub.channels.get(definition.key) === joined)
					hub.channels.delete(definition.key);
			}
			// This holder now reads nobody and nothing: its listeners see that once.
			for (const listener of last) {
				try {
					listener();
				} catch (error) {
					meta.report(asPulseError(error));
				}
			}
		},
	};
	return presence;
}
