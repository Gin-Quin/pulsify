import { afterEach, beforeEach, expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import { createPulse, definePulse } from "pulsify-core";
import { defaultPulseOptions } from "pulsify-core/bindings";
import {
	openRoom,
	ownRoom,
	type OpenRoom,
	type RoomOptions,
} from "../src/demo/room";

const Note = definePulse("RoomNote", object({ title: "string" })).materialize();
const create = (id: string, options: RoomOptions) =>
	createPulse(Note, { id, title: "" }, { ...options, connect: true });

/** A socket that never opens, as one that is still connecting. */
class FakeSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = 0;
	binaryType = "blob";
	bufferedAmount = 0;
	protocol = "";
	constructor(readonly url: string) {
		super();
		sockets.push(this);
	}
	send() {}
	close(code = 1005) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(
			Object.assign(new Event("close"), { code, reason: "", wasClean: true }),
		);
	}
}
let sockets: FakeSocket[] = [];
/** Each POST /api/demo waits for its answer here. */
let answers: Array<{
	signal: AbortSignal | undefined;
	answer: () => void;
}> = [];

const saved = {
	fetch: globalThis.fetch,
	WebSocket: globalThis.WebSocket,
	location: (globalThis as { location?: unknown }).location,
	history: (globalThis as { history?: unknown }).history,
};
const set = (name: string, value: unknown) =>
	Object.defineProperty(globalThis, name, {
		value,
		configurable: true,
		writable: true,
	});
beforeEach(() => {
	sockets = [];
	answers = [];
	set("location", { href: "https://pulsify.cloud/demos/notes" });
	set("history", {
		replaceState: (_: unknown, __: string, url: URL) =>
			((globalThis as { location: { href: string } }).location.href =
				String(url)),
	});
	set("WebSocket", FakeSocket);
	globalThis.fetch = ((_url: string, init?: RequestInit) =>
		new Promise((resolve, reject) => {
			const signal = init?.signal ?? undefined;
			signal?.addEventListener("abort", () => reject(signal.reason));
			answers.push({
				signal,
				answer: () =>
					resolve(
						Response.json({
							url: "wss://cloud.example/project",
							room: "room-1",
							token: "token",
						}),
					),
			});
		})) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = saved.fetch;
	set("WebSocket", saved.WebSocket);
	set("location", saved.location);
	set("history", saved.history);
});
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 100 && !check(); i++) await tick();
	expect(check()).toBe(true);
}

test("a room has its own scope and socket, and closing it releases both", async () => {
	let scope: RoomOptions["scope"] | undefined;
	const opening = openRoom(
		Note,
		(id, options) => create(id, ({ scope } = options)),
		new AbortController().signal,
	);
	await until(() => answers.length === 1);
	answers[0]!.answer();
	const room = await opening;
	expect(location.href).toContain("room=room-1");
	// Nothing leaks into the page's defaults.
	expect(defaultPulseOptions.connectors).toEqual([]);
	await until(() => sockets.length === 1);
	expect(scope!.pulses.get("room-1")).toBe(room.pulse);
	room.close();
	expect(sockets[0]!.readyState).toBe(3);
	expect(scope!.pulses.size).toBe(0);
	await tick(50);
	expect(sockets).toHaveLength(1);
});

test("leaving while the room's session is requested stops the opening", async () => {
	const owned = ownRoom((signal) => openRoom(Note, create, signal));
	await until(() => answers.length === 1);
	owned.dispose();
	expect(answers[0]!.signal?.aborted).toBe(true);
	await expect(owned.pulse).rejects.toMatchObject({ name: "AbortError" });
	expect(location.href).not.toContain("room=");
	await tick(20);
	expect(sockets).toHaveLength(0);
});

test("a failed room creation releases the pulses it created", async () => {
	let scope: RoomOptions["scope"] | undefined;
	const opening = openRoom(
		Note,
		(id, options) => {
			scope = options.scope;
			create(id, options);
			throw new Error("Room creation failed");
		},
		new AbortController().signal,
	);
	await until(() => answers.length === 1);
	answers[0]!.answer();
	await expect(opening).rejects.toThrow("Room creation failed");
	expect(scope!.pulses.size).toBe(0);
});

test("leaving while a joined room loads closes its socket", async () => {
	location.href = "https://pulsify.cloud/demos/notes?room=room-1";
	const owned = ownRoom((signal) => openRoom(Note, create, signal));
	await until(() => answers.length === 1);
	answers[0]!.answer();
	// The load waits for a socket that never opens.
	await until(() => sockets.length === 1);
	owned.dispose();
	await expect(owned.pulse).rejects.toMatchObject({ name: "AbortError" });
	expect(sockets[0]!.readyState).toBe(3);
	await tick(50);
	expect(sockets).toHaveLength(1);
});

test("a room that opens after its owner left is closed at once", async () => {
	let finish!: () => void;
	let closed = 0;
	// It ignores the abort, as a room that was already open would.
	const owned = ownRoom(
		() =>
			new Promise<OpenRoom<string>>((resolve) => {
				finish = () => resolve({ pulse: "pulse", close: () => closed++ });
			}),
	);
	owned.dispose();
	finish();
	await expect(owned.pulse).rejects.toMatchObject({ name: "AbortError" });
	expect(closed).toBe(1);
	// Disposing an open room closes it.
	const open = ownRoom(async () => ({ pulse: "pulse", close: () => closed++ }));
	expect(await open.pulse).toBe("pulse");
	open.dispose();
	expect(closed).toBe(2);
});
