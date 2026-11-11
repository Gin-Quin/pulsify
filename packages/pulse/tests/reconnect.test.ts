import { afterEach, describe, expect, test } from "bun:test";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createWebSocketConnector,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	isRetryable,
	loadPulse,
	PulseError,
	PulseRelay,
	setOnlineMode,
	snapshotPulse,
	subscribePulseStatus,
	type Connector,
	type Pulse,
	type PulseOptions,
	type PulseProperties,
} from "../source/index";
import { rowToPatch } from "../source/connection/PulsePatch";
import type { RelayPeer } from "../source/protocol/PulseRelay";
import { Document, data, eventually, options } from "./helpers";

const backoff = {
	initialDelayMs: 5,
	maxDelayMs: 40,
	factor: 2,
	jitter: 0,
} satisfies PulseOptions["reconnect"];

/**
 * A relay behind a transport we can break: drop live sessions, refuse new
 * ones, go silent, or lose the server's data.
 */
function unreliable(kind: Connector["kind"] = "remote") {
	let relay = new PulseRelay();
	const sessions = new Set<{ drop(error: Error): void }>();
	const state = { down: false, silent: false, opens: 0, refused: 0 };
	const connector: Connector = {
		kind,
		async open({ signal, onMessage, onClose }) {
			state.opens++;
			if (signal.aborted) throw new PulseError("CLOSED", "Aborted");
			if (state.down) {
				state.refused++;
				throw new PulseError("CONNECTION_FAILED", "Unreachable");
			}
			let closed = false;
			const peer = relay.open((bytes) =>
				queueMicrotask(() => {
					if (!closed && !state.silent) onMessage(bytes);
				}),
			);
			const entry = {
				drop(error: Error) {
					if (closed) return;
					close();
					onClose(error);
				},
			};
			const close = () => {
				if (closed) return;
				closed = true;
				peer.close();
				sessions.delete(entry);
			};
			sessions.add(entry);
			signal.addEventListener("abort", close, { once: true });
			return {
				protocolVersion: 1,
				close,
				async send(bytes) {
					if (closed) throw new PulseError("CLOSED", "Closed");
					if (!state.silent) peer.receive(bytes);
				},
			};
		},
	};
	const drop = () => {
		for (const session of [...sessions])
			session.drop(new PulseError("CLOSED", "Dropped"));
	};
	return {
		connector,
		state,
		get relay() {
			return relay;
		},
		get sessions() {
			return sessions.size;
		},
		/** The network goes away: live sessions close, new ones are refused. */
		cut() {
			state.down = true;
			drop();
		},
		restore() {
			state.down = false;
		},
		drop,
		/** The server restarts without its data. */
		reset() {
			relay = new PulseRelay();
			drop();
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
	setOnlineMode(true);
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

describe("automatic reconnection", () => {
	test("a dropped connection reconnects, uploads offline edits and downloads missed ones", async () => {
		const server = unreliable();
		const errors: Error[] = [];
		const a = create([server.connector], { onError: (e) => errors.push(e) });
		await connectPulse(a).synced;
		const b = track(
			await loadPulse(Document, a.id, {
				...options(),
				connectors: [server.connector],
				reconnect: backoff,
				waitFor: "all",
			}),
		);
		const statuses: string[] = [];
		const connection = getPulseMeta(a).connections[0]!;
		connection.on("connecting", () => statuses.push("connecting"));
		connection.on("reconnecting", () => statuses.push("reconnecting"));

		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		a.title = "Written offline by A";
		b.nested.count = 12;
		await eventually(() =>
			expect(server.state.refused).toBeGreaterThanOrEqual(4),
		);
		expect(a.nested.count).toBe(0);

		server.restore();
		await eventually(() => expect(snapshotPulse(a)).toEqual(snapshotPulse(b)));
		expect(a.nested.count).toBe(12);
		expect(b.title).toBe("Written offline by A");
		await eventually(() => {
			expect(getPulseMeta(a).status).toBe("synced");
			expect(getPulseMeta(b).status).toBe("synced");
		});
		expect(statuses.filter((s) => s === "reconnecting").length).toBe(
			statuses.filter((s) => s === "connecting").length,
		);
		// One report for the outage, not one per failed attempt.
		expect(errors.map((error) => (error as PulseError).code)).toEqual([
			"CLOSED",
		]);
		expect(connection.attempt).toBe(0);
		expect(server.relay.peerCount).toBe(2);
		expect(getPulseMeta(a).rowListeners.size).toBe(1);
	});

	test("a reconnection is a full synchronization: a server that lost its data gets everything back", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		a.items.push({ value: 3 });
		await connectPulse(a).synced;
		const rows = server.relay.getLog(a.id)!.size;

		server.reset();
		await eventually(() => expect(server.relay.getLog(a.id)?.size).toBe(rows));
		const fresh = track(
			await loadPulse(Document, a.id, {
				...options(),
				connectors: [createMemoryConnector(server.relay)],
				waitFor: "all",
			}),
		);
		expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
	});

	test("backoff grows exponentially, is capped, and resets after a success", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const delays: number[] = [];
		const connection = getPulseMeta(a).connections[0]!;
		connection.on("reconnecting", (_error, delay, attempt) => {
			delays.push(delay);
			expect(attempt).toBe(delays.length);
		});
		server.cut();
		await eventually(() => expect(delays.length).toBeGreaterThanOrEqual(6));
		expect(delays.slice(0, 6)).toEqual([5, 10, 20, 40, 40, 40]);
		server.restore();
		await eventually(() => expect(connection.status).toBe("synced"));
		expect(connection.attempt).toBe(0);
		delays.length = 0;
		server.cut();
		await eventually(() => expect(delays.length).toBeGreaterThanOrEqual(1));
		expect(delays[0]).toBe(5);
	});

	test("jitter shortens delays at random within its fraction", async () => {
		const server = unreliable();
		server.state.down = true;
		const a = create([server.connector], {
			reconnect: { ...backoff, initialDelayMs: 40, jitter: 0.5 },
		});
		const delays: number[] = [];
		getPulseMeta(a).connections[0]!.on("reconnecting", (_e, delay) =>
			delays.push(delay),
		);
		void connectPulse(a).synced.catch(() => {});
		await eventually(() => expect(delays.length).toBeGreaterThanOrEqual(3));
		for (const delay of delays) {
			expect(delay).toBeGreaterThanOrEqual(20);
			expect(delay).toBeLessThanOrEqual(40);
		}
	});

	test("a connector that is down at startup is retried; ready does not wait for it", async () => {
		const server = unreliable();
		server.state.down = true;
		const a = create([server.connector], { timeoutMs: 60 });
		const task = connectPulse(a);
		expect(await task.ready).toBe(a);
		await expect(task.synced).rejects.toMatchObject({
			code: "TIMEOUT",
			message: expect.stringContaining("Unreachable"),
		});
		// The deadline only concerns the promises: the pulse keeps trying.
		expect(getPulseMeta(a).status).toBe("offline");
		server.restore();
		await eventually(() => expect(getPulseMeta(a).status).toBe("synced"));
		expect(server.relay.getLog(a.id)?.size).toBeGreaterThan(0);
	});

	test("loading through a working local connector does not wait for an unreachable remote", async () => {
		const local = new PulseRelay();
		const remote = unreliable();
		const seed = create([createMemoryConnector(local)]);
		await connectPulse(seed).synced;
		remote.state.down = true;
		const loaded = track(
			await loadPulse(Document, seed.id, {
				...options(),
				connectors: [createMemoryConnector(local), remote.connector],
				reconnect: backoff,
			}),
		);
		expect(loaded.title).toBe(seed.title);
		await eventually(() => expect(getPulseMeta(loaded).status).toBe("offline"));
		loaded.title = "Edited before the remote came back";
		remote.restore();
		await eventually(() => expect(getPulseMeta(loaded).status).toBe("synced"));
		expect(remote.relay.getLog(seed.id)!.vector).toEqual(
			local.getLog(seed.id)!.vector,
		);
	});

	test("a local connector that fails does not block remote ones, and is retried", async () => {
		const local = unreliable("local");
		const remote = new PulseRelay();
		const seed = create([createMemoryConnector(remote, "remote")]);
		await connectPulse(seed).synced;
		local.state.down = true;
		const loaded = track(
			await loadPulse(Document, seed.id, {
				...options(),
				connectors: [local.connector, createMemoryConnector(remote, "remote")],
				reconnect: backoff,
			}),
		);
		expect(loaded.title).toBe(seed.title);
		local.restore();
		await eventually(() => expect(getPulseMeta(loaded).status).toBe("synced"));
		expect(local.relay.getLog(seed.id)!.vector).toEqual(
			remote.getLog(seed.id)!.vector,
		);
	});

	test("a silent peer times out and is reconnected", async () => {
		const server = unreliable();
		const a = create([server.connector], { timeoutMs: 50 });
		await connectPulse(a).synced;
		server.state.silent = true;
		a.title = "Unanswered";
		await eventually(() =>
			expect(getPulseMeta(a).connections[0]!.lastError).toMatchObject({
				code: "TIMEOUT",
			}),
		);
		server.state.silent = false;
		server.drop();
		await eventually(() => expect(getPulseMeta(a).status).toBe("synced"));
		expect(server.relay.getLog(a.id)!.vector).toEqual(
			getPulseMeta(a).log.vector,
		);
	});

	test("going back online retries at once and probes live sessions", async () => {
		const server = unreliable();
		const a = create([server.connector], {
			reconnect: { ...backoff, initialDelayMs: 60_000, maxDelayMs: 60_000 },
			timeoutMs: 50,
		});
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		const opens = server.state.opens;
		setOnlineMode(false);
		server.restore();
		setOnlineMode(false);
		await Bun.sleep(20);
		expect(server.state.opens).toBe(opens);
		setOnlineMode(true);
		await eventually(() => expect(getPulseMeta(a).status).toBe("synced"));

		// A session that silently died is detected by the probe of `online`.
		const connection = getPulseMeta(a).connections[0]!;
		server.state.silent = true;
		setOnlineMode(true);
		await eventually(() => expect(connection.status).toBe("reconnecting"));
		server.state.silent = false;
		setOnlineMode(true);
		await eventually(() => expect(connection.status).toBe("synced"));
	});

	test("lazy waking: an edit shortens a long backoff, a passive document keeps waiting", async () => {
		const server = unreliable();
		const slow = { ...backoff, initialDelayMs: 60_000, maxDelayMs: 60_000 };
		const edited = create([server.connector], { reconnect: slow });
		const passive = create([server.connector], { reconnect: slow });
		await Promise.all([edited, passive].map((p) => connectPulse(p).synced));
		server.cut();
		await eventually(() => {
			expect(getPulseMeta(edited).status).toBe("offline");
			expect(getPulseMeta(passive).status).toBe("offline");
		});
		server.restore();
		const start = performance.now();
		edited.title = "Needs the server";
		await eventually(
			() => expect(getPulseMeta(edited).status).toBe("synced"),
			2_000,
		);
		expect(performance.now() - start).toBeLessThan(1_500);
		expect(server.relay.getLog(edited.id)!.vector).toEqual(
			getPulseMeta(edited).log.vector,
		);
		expect(getPulseMeta(passive).status).toBe("offline");
	});

	test("lazy waking retries at most once a second while the connector stays down", async () => {
		const server = unreliable();
		const a = create([server.connector], {
			reconnect: { ...backoff, initialDelayMs: 60_000, maxDelayMs: 60_000 },
		});
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		const refused = server.state.refused;
		const end = performance.now() + 2_300;
		for (let i = 0; performance.now() < end; i++) {
			a.nested.count = i;
			await Bun.sleep(20);
		}
		const attempts = server.state.refused - refused;
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(attempts).toBeLessThanOrEqual(3);
	});

	test("status listeners see every change once: synced, offline, synced, idle", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		const statuses: string[] = [];
		const stop = subscribePulseStatus(a, (status, pulse) => {
			expect(pulse).toBe(a);
			statuses.push(status);
		});
		expect(statuses).toEqual(["idle"]);
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(statuses.at(-1)).toBe("offline"));
		a.title = "Offline edit";
		server.restore();
		await eventually(() => expect(statuses.at(-1)).toBe("synced"));
		disconnectPulse(a);
		expect(statuses.at(-1)).toBe("idle");
		for (let i = 1; i < statuses.length; i++)
			expect(statuses[i]).not.toBe(statuses[i - 1]);
		const key = statuses.filter((status) =>
			["synced", "offline", "idle"].includes(status),
		);
		expect(key).toEqual(["idle", "synced", "offline", "synced", "idle"]);
		stop();
		await connectPulse(a).synced;
		expect(statuses.at(-1)).toBe("idle");
	});

	test("connectPulse after a drop returns a new attempt that retries now", async () => {
		const server = unreliable();
		const a = create([server.connector], {
			reconnect: { ...backoff, initialDelayMs: 60_000, maxDelayMs: 60_000 },
		});
		const first = connectPulse(a);
		await first.synced;
		expect(connectPulse(a)).toBe(first);
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		server.restore();
		const second = connectPulse(a);
		expect(second).not.toBe(first);
		expect(connectPulse(a)).toBe(second);
		expect(await second.synced).toBe(a);
		expect(connectPulse(a)).toBe(second);
	});

	test("errors that a retry cannot fix stop the connector until connectPulse", async () => {
		const relay = new PulseRelay();
		let readOnly = true;
		const connector: Connector = {
			kind: "remote",
			async open({ onMessage }) {
				const peer = relay.open(
					(bytes) => queueMicrotask(() => onMessage(bytes)),
					{ readOnly },
				);
				return {
					close: () => peer.close(),
					send: async (b) => peer.receive(b),
				};
			},
		};
		let opens = 0;
		const counted: Connector = {
			kind: "remote",
			open: (input) => (opens++, connector.open(input)),
		};
		const errors: Error[] = [];
		const a = create([counted], { onError: (e) => errors.push(e) });
		await expect(connectPulse(a).synced).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await Bun.sleep(30);
		expect(opens).toBe(1);
		expect(getPulseMeta(a).status).toBe("error");
		expect(getPulseMeta(a).connections[0]!.status).toBe("error");
		expect(errors).toHaveLength(1);
		readOnly = false;
		await connectPulse(a).synced;
		expect(getPulseMeta(a).status).toBe("synced");
		expect(opens).toBe(2);
	});

	test("errors can opt out of retries", () => {
		expect(isRetryable(new PulseError("CLOSED", "x"))).toBe(true);
		expect(isRetryable(new PulseError("TIMEOUT", "x"))).toBe(true);
		expect(isRetryable(new PulseError("FORBIDDEN", "x"))).toBe(false);
		expect(
			isRetryable(new PulseError("CLOSED", "x", { retryable: false })),
		).toBe(false);
	});

	test("reconnect: false keeps the previous behavior: one failure stops", async () => {
		const server = unreliable();
		const a = create([server.connector], { reconnect: false });
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("error"));
		await Bun.sleep(20);
		expect(server.state.refused).toBe(0);
	});

	test("disconnectPulse and destroyPulse stop pending retries", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(server.state.refused).toBeGreaterThan(1));
		disconnectPulse(a);
		const refused = server.state.refused;
		await Bun.sleep(60);
		expect(server.state.refused).toBe(refused);
		expect(getPulseMeta(a).status).toBe("idle");
		expect(getPulseMeta(a).connections[0]!.status).toBe("closed");

		server.restore();
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		destroyPulse(a);
		const after = server.state.opens;
		await Bun.sleep(60);
		expect(server.state.opens).toBe(after);
	});

	test("a whenSynced waiter survives an outage instead of failing", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		server.cut();
		await eventually(() => expect(getPulseMeta(a).status).toBe("offline"));
		const connection = getPulseMeta(a).connections[0]!;
		let settled = false;
		const synced = connection.whenSynced.then(() => (settled = true));
		await Bun.sleep(20);
		expect(settled).toBe(false);
		server.restore();
		await synced;
		expect(settled).toBe(true);
	});

	test("many outages with concurrent edits on both sides converge without leaks", async () => {
		const server = unreliable();
		const a = create([server.connector]);
		await connectPulse(a).synced;
		const b = track(
			await loadPulse(Document, a.id, {
				...options(),
				connectors: [server.connector],
				reconnect: backoff,
				waitFor: "all",
			}),
		);
		let seed = 7;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		for (let round = 0; round < 25; round++) {
			const writer = random() < 0.5 ? a : b;
			writer.nested.count = round;
			if (random() < 0.5) writer.items.push({ value: round });
			if (random() < 0.3) server.cut();
			await Bun.sleep(random() * 15);
			(random() < 0.5 ? a : b).title = `Round ${round}`;
			if (random() < 0.7) server.restore();
			if (random() < 0.2) server.drop();
			await Bun.sleep(random() * 10);
		}
		server.restore();
		await eventually(() => {
			expect(getPulseMeta(a).status).toBe("synced");
			expect(getPulseMeta(b).status).toBe("synced");
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		}, 3000);
		expect(server.relay.peerCount).toBe(2);
		expect(server.sessions).toBe(2);
		for (const pulse of [a, b])
			expect(getPulseMeta(pulse).rowListeners.size).toBe(1);
	});
});

describe("reconnection over real WebSockets", () => {
	function startServer(relay: PulseRelay, port = 0) {
		return Bun.serve<{ peer?: RelayPeer }>({
			hostname: "127.0.0.1",
			port,
			fetch(request, server) {
				if (server.upgrade(request, { data: {} })) return;
				return new Response("Upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.data.peer = relay.open((bytes) => socket.sendBinary(bytes));
				},
				message(socket, message) {
					if (typeof message !== "string")
						socket.data.peer!.receive(new Uint8Array(message));
				},
				close(socket) {
					socket.data.peer?.close();
				},
			},
		});
	}

	test("a server restart is survived: clients reconnect and exchange offline edits", async () => {
		const relay = new PulseRelay(rowToPatch);
		let server = startServer(relay);
		const port = server.port!;
		const connector = createWebSocketConnector(`ws://127.0.0.1:${port}`);
		try {
			const a = create([connector]);
			await connectPulse(a).synced;
			const b = track(
				await loadPulse(Document, a.id, {
					...options(),
					connectors: [connector],
					reconnect: backoff,
					waitFor: "all",
				}),
			);
			server.stop(true);
			await eventually(() => {
				expect(getPulseMeta(a).status).toBe("offline");
				expect(getPulseMeta(b).status).toBe("offline");
			});
			a.title = "Edited while the server was down";
			b.items.push({ value: 42 });
			await Bun.sleep(30);
			server = startServer(relay, port);
			await eventually(() => {
				expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
				expect(getPulseMeta(a).status).toBe("synced");
				expect(getPulseMeta(b).status).toBe("synced");
			}, 3000);
			expect(b.title).toBe("Edited while the server was down");
			expect(a.items.map((item) => item.value)).toContain(42);
		} finally {
			for (const pulse of pulses.splice(0)) destroyPulse(pulse);
			server.stop(true);
		}
	});

	test("a server that is down when the app starts is reached once it comes up", async () => {
		const relay = new PulseRelay(rowToPatch);
		const probe = startServer(relay);
		const port = probe.port!;
		probe.stop(true);
		const connector = createWebSocketConnector(`ws://127.0.0.1:${port}`);
		const a = create([connector], { timeoutMs: 100 });
		await expect(connectPulse(a).synced).rejects.toMatchObject({
			code: "TIMEOUT",
		});
		const server = startServer(relay, port);
		try {
			await eventually(
				() => expect(getPulseMeta(a).status).toBe("synced"),
				3000,
			);
			expect(relay.getLog(a.id)?.size).toBeGreaterThan(0);
		} finally {
			for (const pulse of pulses.splice(0)) destroyPulse(pulse);
			server.stop(true);
		}
	});
});

describe("pulses resolve promises safely", () => {
	type Named = PulseProperties<"Named"> & { name: string };
	const Named = definePulse<Named>("Named").materialize<
		Named & { label: string }
	>(({ bind }) => ({ label: bind("name") }));

	for (const [label, definition, input] of [
		["plain", Document, data()],
		["materialized", Named, { name: "Ada" }],
	] as const)
		test(`a ${label} pulse destroyed right after loading is never treated as a thenable`, async () => {
			const relay = new PulseRelay();
			const seed = track(
				createPulse(definition as typeof Document, input as never, {
					...options(),
					connectors: [createMemoryConnector(relay)],
				}),
			);
			await connectPulse(seed).synced;
			// Bun reads `then` of a resolution value one microtask late.
			const loaded = await loadPulse(definition as typeof Document, seed.id, {
				...options(),
				connectors: [createMemoryConnector(relay)],
			});
			destroyPulse(loaded);
			expect((loaded as { then?: unknown }).then).toBeUndefined();
			await Bun.sleep(10);
		});
});
