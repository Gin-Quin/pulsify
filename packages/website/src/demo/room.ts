// What every demo shares: this tab's identity, its room on Pulsify Cloud and
// the online switch. Client only: import it from a clientOnly component.
import { createCloudConnector } from "pulsify-cloud";
import {
	loadPulse,
	PulseError,
	setDefaultPulseOptions,
	setOnlineMode,
	subscribePulseStatus,
	type AnyPulseDefinition,
	type Pulse,
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
async function session(room?: string): Promise<Session> {
	const response = await fetch("/api/demo", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ room }),
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

/**
 * Join the room of the URL, or open a new one and write it in the URL. A room
 * is a root of its own on Pulsify Cloud: one Durable Object. Its root document
 * is made by `create` for the visitor who opened it.
 */
export async function openRoom<P extends Pulse<any>>(
	definition: AnyPulseDefinition,
	create: (id: string) => P,
): Promise<P> {
	const url = new URL(location.href);
	const joining = url.searchParams.get("room") ?? undefined;
	const first = await session(joining);
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
	setDefaultPulseOptions({ connectors: [cloud] });
	if (!joining) return create(first.room);
	try {
		return (await loadPulse(definition, first.room)) as P;
	} catch (error) {
		// The room expired: its root and its grant are gone.
		if (error instanceof PulseError && error.code === "FORBIDDEN")
			throw new RoomExpired();
		if (!(error instanceof PulseError && error.code === "NOT_FOUND"))
			throw error;
		// Whoever opened the room left before saving it.
		return create(first.room);
	}
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
