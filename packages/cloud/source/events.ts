import type { CloudRole } from "./roles.js";
import type { CloudEnvelope, CloudServerInfo } from "./wire.js";

/** What last changed the presence: a page signal, a native one, or time. */
export type PresenceReason =
	| "start"
	| "input"
	| "focus"
	| "blur"
	| "visible"
	| "hidden"
	| "pageshow"
	| "resume"
	| "native"
	| "idle";
/** Whether someone may be looking at this app, and why. */
export type PresenceState = {
	readonly present: boolean;
	readonly reason: PresenceReason;
	/** The page is not reported hidden. */
	readonly visible: boolean;
	/** The window has focus. */
	readonly focused: boolean;
	/** `set(false)` from a native signal is in effect. */
	readonly away: boolean;
	/** Timestamp of the last input or return of the user. */
	readonly lastActivity: number;
};
export type PresenceEvents = {
	/** Presence, visibility, focus or the native override changed. */
	change: [state: PresenceState];
	/** The user came back (input after an absence, focus, page shown). */
	return: [];
};

/** Why a socket was pinged. */
export type CloudPingReason =
	/** Lazy waking: the socket was silent and something is about to be sent. */
	| "send"
	/** Background check while someone is present. */
	| "interval"
	/** The network came back. */
	| "network"
	/** The user came back. */
	| "return"
	/** Timers ran late: the process was suspended. */
	| "resume";
export type CloudConnectionState = "connecting" | "open" | "closed";
/** Events of one socket, to one root's server: a Durable Object or a Unikraft machine. */
export type CloudConnectionEvents = {
	/** Opening, open, or closed with its cause. */
	state: [state: CloudConnectionState, error?: Error];
	/** The server introduced itself. */
	server: [server: CloudServerInfo];
	ping: [reason: CloudPingReason];
	/** A frame answered a ping: the socket is alive. */
	pong: [latencyMs: number];
	/** No frame answered a ping in time: the socket closes and its documents reconnect. */
	timeout: [waitedMs: number];
	/** Timers ran late by `gapMs`: the device slept or the app was in the background. */
	suspended: [gapMs: number];
	/** The server reported a role for a subscribed document. */
	role: [docId: string, role: CloudRole | null];
};
export type CloudConnection = {
	/** The root this socket serves; all its documents share the socket. */
	readonly root: string;
	readonly state: CloudConnectionState;
	/** Who answers: backend, instance and location, once the server said so. */
	readonly server: CloudServerInfo | undefined;
	readonly envelope: CloudEnvelope | undefined;
	readonly documents: readonly string[];
	/** Round trip of the last answered ping. */
	readonly latencyMs: number | undefined;
	/** Why the socket closed. */
	readonly error: Error | undefined;
	on<E extends keyof CloudConnectionEvents>(
		event: E,
		listener: (...args: CloudConnectionEvents[E]) => void,
	): () => void;
};

// Listeners of different events take different arguments.
type AnyListener = (...args: any[]) => void;
export function createEmitter<Events extends Record<string, unknown[]>>() {
	const listeners = new Map<keyof Events, Set<AnyListener>>();
	return {
		on<E extends keyof Events>(
			event: E,
			listener: (...args: Events[E]) => void,
		): () => void {
			let set = listeners.get(event);
			if (!set) listeners.set(event, (set = new Set()));
			set.add(listener);
			return () => set.delete(listener);
		},
		emit<E extends keyof Events>(event: E, ...args: Events[E]): void {
			for (const listener of [...(listeners.get(event) ?? [])])
				try {
					listener(...args);
				} catch (error) {
					// A failing listener must not break the transport; surface it anyway.
					queueMicrotask(() => {
						throw error;
					});
				}
		},
	};
}
