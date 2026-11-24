import { afterEach, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createWebSocketConnector,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	PulseError,
	PulseRelay,
	type Connector,
	type Pulse,
	type PulseOptions,
} from "../source/index";
import { rowToPatch } from "../source/connection/PulsePatch";
import { decodeMessage } from "../source/connection/PulseMessage";
import { vectorCovers } from "../source/connection/PulseVersionVector";
import type { RelayPeer } from "../source/protocol/PulseRelay";
import { Document, data, eventually, options } from "./helpers";

const backoff = {
	initialDelayMs: 5,
	maxDelayMs: 40,
	factor: 2,
	jitter: 0,
} satisfies PulseOptions["reconnect"];

/**
 * A relay whose answers can be held back (a blocked acknowledgement),
 * delayed one by one (a slow paged download) or dropped by a filter.
 */
function gated(relay = new PulseRelay(rowToPatch)) {
	const state = {
		hold: false,
		delayMs: 0,
		drop: (_bytes: Uint8Array) => false,
		uploads: 0,
		opens: 0,
		heartbeatMs: undefined as number | undefined,
		probes: 0,
		/** Most sync requests sent and not completely answered at once. */
		maxOpenProbes: 0,
	};
	let openProbes = 0;
	const held: (() => void)[] = [];
	const sessions = new Set<{
		onMessage(bytes: Uint8Array): void;
		drop(): void;
	}>();
	let chain = Promise.resolve();
	const connector: Connector = {
		kind: "remote",
		async open({ signal, onMessage, onClose }) {
			state.opens++;
			if (signal.aborted) throw new PulseError("CLOSED", "Aborted");
			let closed = false;
			const deliver = (bytes: Uint8Array) => {
				if (closed) return;
				const message = decodeMessage(bytes);
				if (message.kind === 2 && message.complete)
					openProbes = Math.max(0, openProbes - 1);
				onMessage(bytes);
			};
			const peer = relay.open((bytes) => {
				if (state.drop(bytes)) return;
				if (state.hold) held.push(() => deliver(bytes));
				else if (state.delayMs)
					chain = chain
						.then(() => Bun.sleep(state.delayMs))
						.then(() => {
							deliver(bytes);
						});
				else queueMicrotask(() => deliver(bytes));
			});
			const close = () => {
				if (closed) return;
				closed = true;
				peer.close();
				sessions.delete(entry);
			};
			const entry = {
				onMessage,
				drop() {
					if (closed) return;
					close();
					onClose(new PulseError("CLOSED", "Dropped"));
				},
			};
			sessions.add(entry);
			signal.addEventListener("abort", close, { once: true });
			return {
				protocolVersion: 1,
				heartbeatMs: state.heartbeatMs,
				close,
				async send(bytes) {
					if (closed) throw new PulseError("CLOSED", "Closed");
					const kind = decodeMessage(bytes).kind;
					if (kind === 3) state.uploads++;
					if (kind === 1) {
						state.probes++;
						state.maxOpenProbes = Math.max(state.maxOpenProbes, ++openProbes);
					}
					peer.receive(bytes);
				},
			};
		},
	};
	return {
		relay,
		connector,
		state,
		sessions,
		/** Deliver held answers, the first `count` only if given. */
		release(count = Infinity) {
			for (const deliver of held.splice(0, count)) deliver();
		},
		get held() {
			return held.length;
		},
		drop() {
			for (const session of [...sessions]) session.drop();
		},
	};
}

const pulses: Pulse<any>[] = [];
function track<P extends Pulse<any>>(pulse: P): P {
	pulses.push(pulse);
	return pulse;
}
afterEach(() => {
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});
const create = (connectors: Connector[], extra: Partial<PulseOptions> = {}) =>
	track(
		createPulse(Document, data(), {
			...options(),
			connectors,
			reconnect: backoff,
			...extra,
		}),
	);
const settledWithin = async (promise: Promise<unknown>, ms: number) => {
	let settled = false;
	void promise.then(
		() => (settled = true),
		() => (settled = true),
	);
	await Bun.sleep(ms);
	return settled;
};
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("version coverage", () => {
	test("a completed wait releases its abort listener", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		const { signal } = new AbortController();
		await connection.waitSynced(signal);
		expect(getEventListeners(signal, "abort")).toHaveLength(0);

		server.state.hold = true;
		a.title = "Unacknowledged";
		const waiting = connection.waitSynced(signal);
		expect(getEventListeners(signal, "abort")).toHaveLength(1);
		connection.close();
		await expect(waiting).rejects.toMatchObject({ code: "CLOSED" });
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
	});

	test("two probes share the same outstanding request", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		server.state.hold = true;
		const first = connection.probe();
		await eventually(() => expect(server.held).toBe(1));
		expect(connection.probe()).toBe(first);
		server.release();
		await first;
		expect(server.held).toBe(0);
	});

	test("synced and whenSynced read right after an edit wait for its acknowledgement", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		server.state.hold = true;
		a.title = "Edited";
		const target = getPulseMeta(a).log.vector;
		const synced = connectPulse(a).synced;
		const whenSynced = connection.whenSynced;
		expect(await settledWithin(synced, 20)).toBe(false);
		expect(await settledWithin(whenSynced, 0)).toBe(false);
		server.state.hold = false;
		server.release();
		await synced;
		await whenSynced;
		expect(vectorCovers(server.relay.getLog(a.id)!.vector, target)).toBe(true);
		// Once acknowledged, the attempt is reused.
		expect(connectPulse(a)).toBe(connectPulse(a));
	});

	test("a completed batch does not resolve waiters for rows still pending", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		server.state.hold = true;
		a.title = "First";
		await eventually(() => expect(server.held).toBe(1));
		const first = connection.whenSynced;
		a.nested.count = 1;
		const second = connection.whenSynced;
		const target = getPulseMeta(a).log.vector;
		server.release(1);
		await first;
		// The second batch starts after the first: its answer is held too.
		await eventually(() => expect(server.held).toBe(1));
		expect(await settledWithin(second, 20)).toBe(false);
		server.release();
		await second;
		expect(vectorCovers(server.relay.getLog(a.id)!.vector, target)).toBe(true);
	});
});

describe("coalesced uploads", () => {
	test("edits in separate turns while an acknowledgement is blocked upload in one more batch", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		let events = 0;
		connection.on("synced", () => events++);
		const uploads = server.state.uploads;
		server.state.hold = true;
		for (let i = 0; i < 200; i++) {
			a.nested.count = i + 1;
			await turn();
		}
		server.state.hold = false;
		server.release();
		await eventually(() => expect(connection.status).toBe("synced"));
		expect(server.state.uploads - uploads).toBe(2);
		expect(events).toBe(1);
		expect(server.relay.getLog(a.id)!.vector).toEqual(
			getPulseMeta(a).log.vector,
		);
	});

	test("syncBack during an upload in flight covers the frontier at its call", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		server.state.hold = true;
		a.title = "In flight";
		await eventually(() => expect(server.held).toBe(1));
		a.nested.count = 7;
		const target = getPulseMeta(a).log.vector;
		const barrier = connection.syncBack();
		// A second explicit call joins the queued upload.
		expect(connection.syncBack()).toBe(barrier);
		server.release(1);
		expect(await settledWithin(barrier, 20)).toBe(false);
		server.state.hold = false;
		server.release();
		await barrier;
		expect(vectorCovers(connection.clockVector, target)).toBe(true);
		expect(vectorCovers(server.relay.getLog(a.id)!.vector, target)).toBe(true);
	});

	test("edits during a blocked upload and a reconnection are all delivered", async () => {
		const server = gated();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const connection = getPulseMeta(a).connections[0]!;
		server.state.hold = true;
		for (let i = 0; i < 20; i++) {
			a.items.push({ value: i });
			await turn();
		}
		server.drop();
		server.release();
		for (let i = 20; i < 40; i++) {
			a.items.push({ value: i });
			await turn();
		}
		const waiter = connection.whenSynced;
		server.state.hold = false;
		server.release();
		await eventually(() => expect(connection.status).toBe("synced"));
		await waiter;
		expect(server.relay.getLog(a.id)!.vector).toEqual(
			getPulseMeta(a).log.vector,
		);
	});
});

describe("waitFor connectors", () => {
	const down: Connector = {
		kind: "remote",
		async open() {
			throw new PulseError("CONNECTION_FAILED", "Unreachable");
		},
	};

	test("a retryable selected connector times out after ready", async () => {
		const local = createMemoryConnector();
		const seed = create([local]);
		await connectPulse(seed).synced;
		const load = loadPulse(Document, seed.id, {
			...options(),
			connectors: [local, down],
			reconnect: backoff,
			waitFor: [down],
			timeoutMs: 60,
		});
		expect(await settledWithin(load, 400)).toBe(true);
		await expect(load).rejects.toMatchObject({ code: "TIMEOUT" });
	});

	test("an abort after ready settles the wait for a retryable selected connector", async () => {
		const local = createMemoryConnector();
		const seed = create([local]);
		await connectPulse(seed).synced;
		const controller = new AbortController();
		const load = loadPulse(Document, seed.id, {
			...options(),
			connectors: [local, down],
			reconnect: backoff,
			waitFor: [down],
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 30);
		expect(await settledWithin(load, 300)).toBe(true);
		await expect(load).rejects.toMatchObject({ code: "CLOSED" });
	});

	test("joining a loaded pulse keeps the caller's own deadline and signal", async () => {
		const local = createMemoryConnector();
		const scope = options();
		const seed = create([local]);
		await connectPulse(seed).synced;
		const loaded = track(
			await loadPulse(Document, seed.id, {
				...scope,
				connectors: [local, down],
				reconnect: backoff,
				timeoutMs: 10_000,
			}),
		);
		const remote = getPulseMeta(loaded).connections[1]!;
		for (let i = 0; i < 3; i++)
			await expect(
				loadPulse(Document, seed.id, {
					...scope,
					connectors: [local, down],
					waitFor: [down],
					timeoutMs: 40,
				}),
			).rejects.toMatchObject({ code: "TIMEOUT" });
		// Timed-out loads leave no wait behind on the retrying connector.
		expect((remote as any).syncWaiters.size).toBe(0);
		const controller = new AbortController();
		const joined = loadPulse(Document, seed.id, {
			...scope,
			connectors: [local, down],
			waitFor: "synced",
			signal: controller.signal,
		});
		controller.abort();
		await expect(joined).rejects.toMatchObject({ code: "CLOSED" });
		// The load gave up; the synchronization it joined goes on.
		expect(getPulseMeta(loaded).destroyed).toBe(false);
		expect(remote.active).toBe(true);
		expect(remote.status).toBe("reconnecting");
	});
});

test("one idle probe at a time, then the idle wait starts again", async () => {
	const server = gated();
	const writer = gated(server.relay);
	server.state.heartbeatMs = 10;
	const a = create([server.connector], { timeoutMs: 1_000 });
	await connectPulse(a).synced;
	const b = track(
		await loadPulse(Document, a.id, {
			...options(),
			connectors: [writer.connector],
			waitFor: "all",
		}),
	);
	// Answers slower than the idle wait, and broadcasts that restart it while
	// a probe waits for its answer: a second probe must not start.
	server.state.delayMs = 40;
	const probes = server.state.probes;
	server.state.maxOpenProbes = 0;
	for (let i = 0; i < 15; i++) {
		b.nested.count = i + 1;
		await Bun.sleep(20);
	}
	await Bun.sleep(100);
	expect(server.state.probes - probes).toBeGreaterThan(1);
	expect(server.state.maxOpenProbes).toBe(1);
	expect(getPulseMeta(a).connections[0]!.status).toBe("synced");
});

describe("paged downloads", () => {
	/**
	 * A pulse loaded with a request timeout of `timeoutMs`, then disconnected
	 * while the relay received two pages of rows it misses.
	 */
	async function behind(timeoutMs = 10_000) {
		const server = gated();
		const seed = create([server.connector]);
		await connectPulse(seed).synced;
		const loaded = track(
			await loadPulse(Document, seed.id, {
				...options(),
				connectors: [server.connector],
				reconnect: backoff,
				timeoutMs,
			}),
		);
		disconnectPulse(loaded);
		for (let i = 0; i < 4200; i++) seed.items.push({ value: i });
		await connectPulse(seed).synced;
		const seen = { partial: 0, complete: 0 };
		server.state.drop = (bytes) => {
			const message = decodeMessage(bytes);
			if (message.kind === 2) seen[message.complete ? "complete" : "partial"]++;
			return false;
		};
		return { server, seed, loaded, seen };
	}

	test("timely pages keep a download alive past the request timeout", async () => {
		const { server, seed, loaded, seen } = await behind(300);
		server.state.delayMs = 200;
		const started = performance.now();
		await connectPulse(loaded, { timeoutMs: 10_000 }).connected;
		expect(performance.now() - started).toBeGreaterThan(300);
		expect(seen.partial).toBeGreaterThan(0);
		expect(seen.complete).toBe(1);
		expect(getPulseMeta(loaded).connections[0]!.lastError).toBeUndefined();
		expect(loaded.items.length).toBe(seed.items.length);
	});

	test("the overall initial deadline still bounds a slow healthy download", async () => {
		const { server, loaded } = await behind(300);
		server.state.delayMs = 200;
		await expect(
			connectPulse(loaded, { timeoutMs: 250 }).connected,
		).rejects.toMatchObject({ code: "TIMEOUT" });
	});

	test("a missing final page times out after inactivity and reconnects", async () => {
		const { server, seed, loaded } = await behind(50);
		server.state.drop = (bytes) => {
			const message = decodeMessage(bytes);
			return message.kind === 2 && message.complete;
		};
		const connection = getPulseMeta(loaded).connections[0]!;
		void connectPulse(loaded, { timeoutMs: 5_000 });
		await eventually(() =>
			expect(connection.lastError).toMatchObject({ code: "TIMEOUT" }),
		);
		server.state.drop = () => false;
		await eventually(() => expect(connection.status).toBe("synced"));
		expect(loaded.items.length).toBe(seed.items.length);
	});

	test("a page from an obsolete session is ignored", async () => {
		const { server, loaded } = await behind();
		const late: Uint8Array[] = [];
		server.state.drop = (bytes) => {
			const message = decodeMessage(bytes);
			if (message.kind === 2 && !message.complete && !late.length)
				late.push(bytes);
			return false;
		};
		const connection = getPulseMeta(loaded).connections[0]!;
		const errors: Error[] = [];
		connection.on("error", (error) => errors.push(error));
		await connectPulse(loaded).synced;
		const [old] = [...server.sessions];
		server.drop();
		await eventually(() => expect(connection.status).toBe("synced"));
		const reported = errors.length;
		old!.onMessage(late[0]!);
		await Bun.sleep(10);
		expect(errors.length).toBe(reported);
		expect(connection.status).toBe("synced");
	});
});

describe("WebSocket heartbeat", () => {
	function blackholeServer() {
		const relay = new PulseRelay(rowToPatch);
		const state = { blackhole: false, frames: 0 };
		const server = Bun.serve<{ peer?: RelayPeer }>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request, { data: {} })) return;
				return new Response("Upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.data.peer = relay.open((bytes) => {
						if (!state.blackhole) socket.sendBinary(bytes);
					});
				},
				message(socket, message) {
					state.frames++;
					if (state.blackhole || typeof message === "string") return;
					socket.data.peer!.receive(new Uint8Array(message as Buffer));
				},
				close(socket) {
					socket.data.peer?.close();
				},
			},
		});
		return { server, state, url: `ws://127.0.0.1:${server.port}` };
	}

	test("an idle session that silently stops answering reconnects without writes or online events", async () => {
		const { server, state, url } = blackholeServer();
		try {
			const a = create(
				[createWebSocketConnector(url, undefined, { heartbeatMs: 30 })],
				{ timeoutMs: 50 },
			);
			await connectPulse(a).synced;
			const connection = getPulseMeta(a).connections[0]!;
			// Healthy and idle: heartbeats are answered.
			const frames = state.frames;
			await Bun.sleep(100);
			expect(state.frames).toBeGreaterThan(frames);
			expect(connection.status).toBe("synced");
			state.blackhole = true;
			await eventually(
				() => expect(connection.lastError).toMatchObject({ code: "TIMEOUT" }),
				1_000,
			);
			state.blackhole = false;
			await eventually(() => expect(connection.status).toBe("synced"), 1_000);
		} finally {
			server.stop(true);
		}
	});

	test("heartbeats can be disabled; other connectors send nothing while idle", async () => {
		const { server, state, url } = blackholeServer();
		const relay = new PulseRelay();
		let received = 0;
		const receive = relay.open.bind(relay);
		relay.open = ((send: any, opts: any) => {
			const peer = receive(send, opts);
			const inner = peer.receive.bind(peer);
			peer.receive = (bytes: Uint8Array) => {
				received++;
				return inner(bytes);
			};
			return peer;
		}) as typeof relay.open;
		try {
			const a = create(
				[
					createWebSocketConnector(url, undefined, { heartbeatMs: false }),
					createMemoryConnector(relay, "remote"),
				],
				{ timeoutMs: 50 },
			);
			await connectPulse(a).synced;
			const frames = state.frames;
			const before = received;
			await Bun.sleep(100);
			expect(state.frames).toBe(frames);
			expect(received).toBe(before);
		} finally {
			server.stop(true);
		}
	});
});
