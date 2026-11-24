// What every demo shares: this tab's identity, its room on Pulsify Cloud and
// the online switch. Client only: import it from a clientOnly component.
import { createCloudConnector } from "pulsify-cloud";
import {
	createPulseScope,
	destroyPulse,
	loadPulse,
	PulseError,
	setOnlineMode,
	subscribePulseStatus,
	type AnyPulseDefinition,
	type Connector,
	type Pulse,
	type PulseScope,
	type SynchronizationStatus,
} from "pulsify-core";
import { createSignal, onCleanup } from "solid-js";

/** This tab: kept across its reloads, new in every other tab. */
export type Person = { id: string; name: string; color: string };

const ADJECTIVES = ["Neon", "Cosmic", "Swift", "Lucky", "Quiet", "Bright"];
const ANIMALS = ["Fox", "Owl", "Lynx", "Otter", "Raven", "Panda", "Heron"];
/** Readable on white, under white labels, and on the dark pong table. */
const COLORS = [
	"#d946ef",
	"#0891b2",
	"#2563eb",
	"#16a34a",
	"#ea580c",
	"#e11d48",
	"#7c3aed",
	"#0d9488",
];
const pick = <T>(list: readonly T[]) =>
	list[Math.floor(Math.random() * list.length)]!;

export const me: Person = (() => {
	try {
		const stored = sessionStorage.getItem("pulsify-demo-me");
		if (stored) return JSON.parse(stored) as Person;
	} catch {
		// Storage blocked: a new identity for this page.
	}
	const person = {
		id: crypto.randomUUID(),
		name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
		color: pick(COLORS),
	};
	try {
		sessionStorage.setItem("pulsify-demo-me", JSON.stringify(person));
	} catch {
		// Storage blocked: the identity lasts for this page.
	}
	return person;
})();

type Session = { url: string; room: string; token: string };
/** The website's backend, worker.ts: a new room, or a token for one. */
async function session(room?: string, signal?: AbortSignal): Promise<Session> {
	const response = await fetch("/api/demo", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ room }),
		signal: signal ?? null,
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new Error(body.error ?? `The demo API answered ${response.status}`);
	return body as Session;
}

/** Rooms are erased ten minutes after the last person left (worker.ts). */
export class RoomExpired extends Error {
	constructor() {
		super(
			"This room has expired: rooms close ten minutes after everyone left.",
		);
	}
}

const sockets = new Set<WebSocket>();

/** What a room's pulses are created and loaded with: its own scope and socket. */
export type RoomOptions = { scope: PulseScope; connectors: Connector[] };
/** An open room: its root pulse, and `close` to destroy its pulses and socket. */
export type OpenRoom<P> = { pulse: P; close(): void };

const aborted = () => new DOMException("The room was closed", "AbortError");

/**
 * Join the room of the URL, or open a new one and write it in the URL. A room
 * is a root of its own on Pulsify Cloud: one Durable Object. Its root document
 * is made by `create`, with the room's options, for the visitor who opened it.
 * Each room has its own scope and connector, nothing global: once `signal`
 * aborts, opening stops and whatever it made is closed.
 */
export async function openRoom<P extends Pulse<any>>(
	definition: AnyPulseDefinition,
	create: (id: string, options: RoomOptions) => P,
	signal: AbortSignal,
): Promise<OpenRoom<P>> {
	const url = new URL(location.href);
	const joining = url.searchParams.get("room") ?? undefined;
	const first = await session(joining, signal);
	if (signal.aborted) throw aborted();
	if (!joining) {
		url.searchParams.set("room", first.room);
		history.replaceState(null, "", url);
	}
	let token: string | undefined = first.token;
	const cloud = createCloudConnector({
		url: first.url,
		// The first socket uses the room's token; every reconnection asks for a new one.
		token: async () => {
			const current = token;
			token = undefined;
			return current ?? (await session(first.room)).token;
		},
		createSocket(url, protocols) {
			const socket = new WebSocket(url, protocols);
			sockets.add(socket);
			socket.addEventListener("close", () => sockets.delete(socket));
			return socket;
		},
	});
	const options: RoomOptions = {
		scope: createPulseScope(),
		connectors: [cloud],
	};
	const close = () => {
		cloud.close();
		for (const pulse of [...options.scope.pulses.values()]) destroyPulse(pulse);
	};
	const opened = (pulse: P): OpenRoom<P> => {
		if (signal.aborted) {
			close();
			throw aborted();
		}
		return { pulse, close };
	};
	if (!joining) return opened(create(first.room, options));
	try {
		return opened(
			(await loadPulse(definition, first.room, { ...options, signal })) as P,
		);
	} catch (error) {
		if (signal.aborted) {
			close();
			throw aborted();
		}
		// The room expired: its root and its grant are gone.
		if (error instanceof PulseError && error.code === "FORBIDDEN") {
			close();
			throw new RoomExpired();
		}
		if (!(error instanceof PulseError && error.code === "NOT_FOUND")) {
			close();
			throw error;
		}
		// Whoever opened the room left before saving it.
		return opened(create(first.room, options));
	}
}

/**
 * Owns a room for one component: `dispose`, on unmount, aborts the opening,
 * or closes the room once open, even if it opens later.
 */
export function ownRoom<P>(
	open: (signal: AbortSignal) => Promise<OpenRoom<P>>,
): {
	pulse: Promise<P>;
	dispose(): void;
} {
	const controller = new AbortController();
	let room: OpenRoom<P> | undefined;
	const pulse = open(controller.signal).then((opened) => {
		room = opened;
		if (controller.signal.aborted) {
			opened.close();
			throw aborted();
		}
		return opened.pulse;
	});
	return {
		pulse,
		dispose() {
			controller.abort();
			room?.close();
		},
	};
}

const [online, setOnlineSignal] = createSignal(true);
export { online };
/**
 * Offline closes every socket as a lost network would and pauses
 * reconnection; edits continue locally and merge once online again.
 */
export function setOnline(value: boolean) {
	setOnlineSignal(value);
	setOnlineMode(value);
	if (!value) for (const socket of sockets) socket.close();
}

/** The synchronization status of a pulse, as a signal. */
export function createStatus(pulse: Pulse<any>) {
	const [status, setStatus] = createSignal<SynchronizationStatus>("syncing");
	onCleanup(subscribePulseStatus(pulse, (next) => setStatus(next)));
	return status;
}
