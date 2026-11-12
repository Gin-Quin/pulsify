import { describe, expect, test } from "bun:test";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	definePresence,
	destroyPulse,
	disconnectPulse,
	encodeMessage,
	getPulseMeta,
	joinPresence,
	loadPulse,
	map,
	object,
	optional,
	PulseRelay,
	relayStoreMessage,
	set,
	tuple,
	array,
	type Connector,
	type Pulse,
} from "../source/index";
import {
	createPresenceBudget,
	decodePresenceFrame,
	encodePresenceFrame,
	encodePresenceLeave,
	isPresenceFrame,
	MAX_PRESENCE_BYTES,
	PresenceEvent,
	relayPresenceFrame,
} from "../source/protocol";
import { Document, data, eventually, options } from "./helpers";

const Viewer = definePresence(
	"viewer",
	object({ name: "string", color: "string" }),
	{ throttleMs: 0 },
);
const Cursor = definePresence(
	"cursor",
	object({ x: "float32", y: "float32" }),
	{ throttleMs: 0 },
);

/** Two pulses of one document, each through its own session of one relay. */
async function pair(connector?: Connector, relay = new PulseRelay()) {
	const use = connector ?? createMemoryConnector(relay);
	const a = createPulse(Document, data(), { ...options(), connectors: [use] });
	await connectPulse(a).synced;
	const b = await loadPulse(Document, a.id, {
		...options(),
		connectors: [use],
		waitFor: "all",
	});
	return { a, b, relay, connector: use };
}
const join = (relay: PulseRelay, a: Pulse<any>) =>
	loadPulse(Document, a.id, {
		...options(),
		connectors: [createMemoryConnector(relay)],
		waitFor: "all",
	});

describe("presence", () => {
	test("peers see each other's state, not their own", async () => {
		const { a, b } = await pair();
		const mine = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		expect(mine.others).toEqual([]);
		mine.set({ name: "Ada", color: "red" });
		expect(mine.mine).toEqual({ name: "Ada", color: "red" });
		await eventually(() =>
			expect(theirs.others.map((other) => other.state)).toEqual([
				{ name: "Ada", color: "red" },
			]),
		);
		expect(mine.others).toEqual([]);
		theirs.set({ name: "Grace", color: "green" });
		await eventually(() =>
			expect(mine.others.map((other) => other.state)).toEqual([
				{ name: "Grace", color: "green" },
			]),
		);
		expect(mine.others[0]!.peer).toBeGreaterThan(0);
		expect(Object.keys(mine.others[0]!).sort()).toEqual(["peer", "state"]);
		expect(mine.others[0]!.peer).not.toBe(theirs.others[0]!.peer);
	});

	test("a newcomer receives the states that were set before it joined", async () => {
		const { a, b, relay } = await pair();
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		joinPresence(b, Viewer).set({ name: "Grace", color: "green" });
		const c = await join(relay, a);
		const late = joinPresence(c, Viewer);
		await eventually(() =>
			expect(late.others.map((other) => other.state.name).sort()).toEqual([
				"Ada",
				"Grace",
			]),
		);
	});

	test("a state set before connecting is sent once connected", async () => {
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const a = createPulse(Document, data(), {
			...options(),
			connectors: [connector],
		});
		const offline = joinPresence(a, Viewer);
		offline.set({ name: "Ada", color: "red" });
		expect(offline.others).toEqual([]);
		await connectPulse(a).synced;
		const b = await join(relay, a);
		const theirs = joinPresence(b, Viewer);
		await eventually(() => expect(theirs.others).toHaveLength(1));
	});

	test("channels are separate and share the peer number", async () => {
		const { a, b } = await pair();
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		joinPresence(a, Cursor).set({ x: 1, y: 2 });
		const viewers = joinPresence(b, Viewer);
		const cursors = joinPresence(b, Cursor);
		await eventually(() => {
			expect(viewers.others).toHaveLength(1);
			expect(cursors.others).toHaveLength(1);
		});
		expect(cursors.others[0]!.state).toEqual({ x: 1, y: 2 });
		expect(cursors.others[0]!.peer).toBe(viewers.others[0]!.peer);
	});

	test("another schema under the same name is another channel", async () => {
		const { a, b } = await pair();
		const Other = definePresence("viewer", object({ name: "string" }), {
			throttleMs: 0,
		});
		expect(Other.key).not.toBe(Viewer.key);
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		const other = joinPresence(b, Other);
		const same = joinPresence(b, Viewer);
		await eventually(() => expect(same.others).toHaveLength(1));
		expect(other.others).toEqual([]);
	});

	test("set(undefined) removes my state and keeps theirs", async () => {
		const { a, b } = await pair();
		const mine = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		mine.set({ name: "Ada", color: "red" });
		theirs.set({ name: "Grace", color: "green" });
		await eventually(() => expect(theirs.others).toHaveLength(1));
		mine.set(undefined);
		expect(mine.mine).toBeUndefined();
		await eventually(() => expect(theirs.others).toEqual([]));
		expect(mine.others).toHaveLength(1);
	});

	test("a session that ends leaves every channel", async () => {
		const { a, b } = await pair();
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		joinPresence(a, Cursor).set({ x: 1, y: 2 });
		const viewers = joinPresence(b, Viewer);
		const cursors = joinPresence(b, Cursor);
		await eventually(() => {
			expect(viewers.others).toHaveLength(1);
			expect(cursors.others).toHaveLength(1);
		});
		destroyPulse(a);
		await eventually(() => {
			expect(viewers.others).toEqual([]);
			expect(cursors.others).toEqual([]);
		});
	});

	test("offline: others are dropped, mine is kept and sent again as a new peer", async () => {
		const { a, b } = await pair();
		const mine = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		mine.set({ name: "Ada", color: "red" });
		theirs.set({ name: "Grace", color: "green" });
		await eventually(() => {
			expect(mine.others).toHaveLength(1);
			expect(theirs.others).toHaveLength(1);
		});
		const before = theirs.others[0]!.peer;
		disconnectPulse(a);
		expect(mine.others).toEqual([]);
		expect(mine.mine).toEqual({ name: "Ada", color: "red" });
		await eventually(() => expect(theirs.others).toEqual([]));
		mine.set({ name: "Ada", color: "blue" });
		await connectPulse(a).synced;
		await eventually(() => {
			expect(theirs.others.map((other) => other.state.color)).toEqual(["blue"]);
			expect(mine.others).toHaveLength(1);
		});
		expect(theirs.others[0]!.peer).not.toBe(before);
	});

	test("others keeps its identity until something changes, peer by peer", async () => {
		const { a, b, relay } = await pair();
		const c = await join(relay, a);
		const ada = joinPresence(a, Cursor);
		const grace = joinPresence(b, Cursor);
		const watcher = joinPresence(c, Cursor);
		ada.set({ x: 1, y: 1 });
		grace.set({ x: 2, y: 2 });
		await eventually(() => expect(watcher.others).toHaveLength(2));
		const before = watcher.others;
		expect(watcher.others).toBe(before);
		const unchanged = before.find((other) => other.state.x === 2)!;
		ada.set({ x: 5, y: 5 });
		await eventually(() =>
			expect(watcher.others.some((other) => other.state.x === 5)).toBe(true),
		);
		expect(watcher.others).not.toBe(before);
		expect(watcher.others).toContain(unchanged);
		expect(Object.isFrozen(watcher.others)).toBe(true);
	});

	test("subscribe is called at once, then on every change of others or mine", async () => {
		const { a, b } = await pair();
		const mine = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		const seen: number[] = [];
		const stop = theirs.subscribe((presence) => {
			expect(presence).toBe(theirs);
			seen.push(presence.others.length);
		});
		expect(seen).toEqual([0]);
		mine.set({ name: "Ada", color: "red" });
		await eventually(() => expect(seen).toEqual([0, 1]));
		theirs.set({ name: "Grace", color: "green" });
		expect(seen).toEqual([0, 1, 1]);
		stop();
		mine.set(undefined);
		await eventually(() => expect(theirs.others).toEqual([]));
		expect(seen).toEqual([0, 1, 1]);
	});

	test("joins are counted; leave is idempotent and removes my state at the last one", async () => {
		const { a, b } = await pair();
		const first = joinPresence(a, Viewer);
		const second = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		first.set({ name: "Ada", color: "red" });
		expect(second.mine).toEqual({ name: "Ada", color: "red" });
		await eventually(() => expect(theirs.others).toHaveLength(1));
		let calls = 0;
		first.subscribe(() => calls++);
		first.leave();
		first.leave();
		expect(first.mine).toBeUndefined();
		expect(first.others).toEqual([]);
		first.set({ name: "Nobody", color: "none" });
		expect(second.mine).toEqual({ name: "Ada", color: "red" });
		second.set({ name: "Ada", color: "blue" });
		// Once at the subscription and once when it left, never afterwards.
		expect(calls).toBe(2);
		await eventually(() => expect(theirs.others[0]!.state.color).toBe("blue"));
		second.leave();
		await eventually(() => expect(theirs.others).toEqual([]));
		const again = joinPresence(a, Viewer);
		expect(again.mine).toBeUndefined();
	});

	test("leaving right after clearing still tells the others, despite the throttle", async () => {
		const { a, b } = await pair();
		const Slow = definePresence("slow-leave", object({ n: "uint" }), {
			throttleMs: 10_000,
		});
		const mine = joinPresence(a, Slow);
		const theirs = joinPresence(b, Slow);
		mine.set({ n: 1 });
		await eventually(() => expect(theirs.others).toHaveLength(1));
		// The clear waits for the throttle interval; leave must not drop it.
		mine.set(undefined);
		mine.leave();
		await eventually(() => expect(theirs.others).toEqual([]));
	});

	test("states are validated, detached and bounded", async () => {
		const { a } = await pair();
		const mine = joinPresence(a, Viewer);
		expect(() => mine.set({ name: 1 } as never)).toThrow();
		expect(mine.mine).toBeUndefined();
		const state = { name: "Ada", color: "red" };
		mine.set(state);
		expect(mine.mine).not.toBe(state);
		expect(() =>
			mine.set({ name: "x".repeat(MAX_PRESENCE_BYTES), color: "" }),
		).toThrow("16 KiB");
		expect(mine.mine).toEqual(state);
	});

	test("updates are throttled to the latest state", async () => {
		const { a, b } = await pair();
		const Slow = definePresence("slow", object({ n: "uint" }), {
			throttleMs: 40,
		});
		const mine = joinPresence(a, Slow);
		const theirs = joinPresence(b, Slow);
		const seen: number[] = [];
		theirs.subscribe(({ others }) => {
			if (others[0]) seen.push(others[0].state.n);
		});
		for (let n = 1; n <= 20; n++) mine.set({ n });
		await eventually(() => expect(seen.at(-1)).toBe(20));
		expect(seen).toEqual([1, 20]);
	});

	test("readers publish presence, and subjects come from the relay", async () => {
		const relay = new PulseRelay();
		const session = (subject: string, readOnly = false): Connector => ({
			kind: "remote",
			async open({ onMessage }) {
				const peer = relay.open(
					(bytes) => queueMicrotask(() => onMessage(bytes)),
					{ subject, readOnly },
				);
				return {
					presence: true,
					close: () => peer.close(),
					send: async (bytes) => peer.receive(bytes),
				};
			},
		});
		const a = createPulse(Document, data(), {
			...options(),
			connectors: [session("ada")],
		});
		await connectPulse(a).synced;
		const b = await loadPulse(Document, a.id, {
			...options(),
			connectors: [session("grace", true)],
			waitFor: "connected",
		});
		const mine = joinPresence(a, Viewer);
		const reader = joinPresence(b, Viewer);
		reader.set({ name: "I am Ada", color: "red" });
		await eventually(() => expect(mine.others).toHaveLength(1));
		expect(mine.others[0]!.subject).toBe("grace");
	});

	test("a connector that does not relay presence sends nothing", async () => {
		const relay = new PulseRelay();
		const memory = createMemoryConnector(relay);
		const frames: Uint8Array[] = [];
		const silent: Connector = {
			kind: "remote",
			async open(input) {
				const session = await memory.open(input);
				return {
					close: session.close,
					send: async (bytes) => {
						frames.push(bytes);
						await session.send(bytes);
					},
				};
			},
		};
		const { a } = await pair(silent, relay);
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(frames.some(isPresenceFrame)).toBe(false);
	});

	test("presence uses one relay at a time and fails over to the next", async () => {
		const first = new PulseRelay();
		const second = new PulseRelay();
		const connectors = () => [
			createMemoryConnector(first, "remote"),
			createMemoryConnector(second, "remote"),
		];
		const a = createPulse(Document, data(), {
			...options(),
			connectors: connectors(),
		});
		await connectPulse(a).synced;
		const b = await loadPulse(Document, a.id, {
			...options(),
			connectors: connectors(),
			waitFor: "all",
		});
		const mine = joinPresence(a, Viewer);
		const theirs = joinPresence(b, Viewer);
		mine.set({ name: "Ada", color: "red" });
		await eventually(() => expect(theirs.others).toHaveLength(1));
		// One entry, although both pulses share two relays.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(theirs.others).toHaveLength(1);
		for (const pulse of [a, b]) getPulseMeta(pulse).connections[0]!.close();
		expect(theirs.others).toEqual([]);
		await eventually(() => expect(theirs.others).toHaveLength(1));
		expect(theirs.others[0]!.state.name).toBe("Ada");
	});

	test("a relay forwards presence only to sessions that use it", async () => {
		const relay = new PulseRelay();
		const received: Uint8Array[] = [];
		const old = relay.open((bytes) => received.push(bytes));
		const { a, b } = await pair(undefined, relay);
		old.receive(encodeMessage({ kind: 1, docId: a.id, requestId: 1, vv: [] }));
		received.length = 0;
		const theirs = joinPresence(b, Viewer);
		joinPresence(a, Viewer).set({ name: "Ada", color: "red" });
		await eventually(() => expect(theirs.others).toHaveLength(1));
		destroyPulse(a);
		await eventually(() => expect(theirs.others).toEqual([]));
		expect(received.some(isPresenceFrame)).toBe(false);
	});

	test("a relay forwards 200 frames per session and second, then drops", () => {
		const relay = new PulseRelay();
		const received: Uint8Array[] = [];
		const connect = (send: (bytes: Uint8Array) => void) => {
			const peer = relay.open(send);
			peer.receive(
				encodeMessage({ kind: 1, docId: "doc", requestId: 1, vv: [] }),
			);
			return peer;
		};
		const frame = (event: 0 | 1) =>
			encodePresenceFrame({
				docId: "doc",
				peer: 0,
				to: 0,
				event,
				subject: "",
				channel: "cursor#abcd",
				state: event ? new Uint8Array([1]) : new Uint8Array(),
			});
		const listener = connect((bytes) => received.push(bytes));
		listener.receive(frame(0));
		const sender = connect(() => {});
		const now = Date.now;
		try {
			Date.now = () => 1_000_000;
			received.length = 0;
			for (let i = 0; i < 201; i++) sender.receive(frame(1));
			expect(received.filter(isPresenceFrame)).toHaveLength(200);
			// The next second starts a new budget.
			Date.now = () => 1_001_000;
			sender.receive(frame(1));
			expect(received.filter(isPresenceFrame)).toHaveLength(201);
		} finally {
			Date.now = now;
		}
		const allow = createPresenceBudget(3);
		expect([allow(), allow(), allow(), allow()]).toEqual([
			true,
			true,
			true,
			false,
		]);
	});

	test("a recipient whose socket throws does not keep presence from the others", () => {
		const relay = new PulseRelay();
		const healthy: Uint8Array[] = [];
		const connect = (send: (bytes: Uint8Array) => void) => {
			const peer = relay.open(send);
			peer.receive(
				encodeMessage({ kind: 1, docId: "doc", requestId: 1, vv: [] }),
			);
			return peer;
		};
		const join = encodePresenceFrame({
			docId: "doc",
			peer: 0,
			to: 0,
			event: PresenceEvent.join,
			subject: "",
			channel: "cursor#abcd",
			state: new Uint8Array(),
		});
		let broken = false;
		// Opened first, so it is tried before the healthy session.
		connect((bytes) => {
			if (broken && isPresenceFrame(bytes))
				throw new Error("socket is closing");
		}).receive(join);
		connect((bytes) => healthy.push(bytes)).receive(join);
		const sender = connect(() => {});
		broken = true;
		healthy.length = 0;
		sender.receive(join);
		expect(healthy.filter(isPresenceFrame)).toHaveLength(1);
		// Its departure reaches the healthy session too, and close does not throw.
		sender.close();
		expect(
			healthy
				.filter(isPresenceFrame)
				.map((bytes) => decodePresenceFrame(bytes).event),
		).toEqual([PresenceEvent.join, PresenceEvent.leave]);
	});

	test("a schema whose collections could not be bounded is refused", () => {
		for (const schema of [
			array("null"),
			array(object({})),
			array(tuple()),
			object({ tags: set("undefined") }),
			array(array("null")),
		])
			expect(() => definePresence("unbounded", schema)).toThrow("no bytes");
		// One byte per element is enough: the codec stops at the end of the state.
		for (const schema of [
			array("boolean"),
			array(optional("null")),
			array(object({ a: "null", b: "uint" })),
			map("null"),
		])
			expect(() => definePresence("bounded", schema)).not.toThrow();
	});

	test("a state that claims more elements than its bytes hold is ignored", async () => {
		const { a, b, relay } = await pair();
		const Tags = definePresence("tags", array("string"), { throttleMs: 0 });
		const theirs = joinPresence(b, Tags);
		joinPresence(a, Tags);
		const raw = relay.open(() => {});
		raw.receive(encodeMessage({ kind: 1, docId: a.id, requestId: 1, vv: [] }));
		raw.receive(
			encodePresenceFrame({
				docId: a.id,
				peer: 0,
				to: 0,
				event: PresenceEvent.state,
				subject: "",
				channel: Tags.key,
				// A length of 268 million strings, and no string.
				state: new Uint8Array([0xff, 0xff, 0xff, 0x7f]),
			}),
		);
		a.title = "Still synchronized";
		await eventually(() => expect(b.title).toBe("Still synchronized"));
		expect(theirs.others).toEqual([]);
	});

	test("a holder that leaves is told once, and reads nobody", async () => {
		const { a, b } = await pair();
		const mine = joinPresence(a, Viewer);
		const other = joinPresence(a, Viewer);
		joinPresence(b, Viewer).set({ name: "Grace", color: "green" });
		mine.set({ name: "Ada", color: "red" });
		await eventually(() => expect(mine.others).toHaveLength(1));
		const seen: string[] = [];
		mine.subscribe(({ others, mine }) =>
			seen.push(`${mine?.name}:${others.length}`),
		);
		const kept: string[] = [];
		other.subscribe(({ others, mine }) =>
			kept.push(`${mine?.name}:${others.length}`),
		);
		mine.leave();
		expect(seen).toEqual(["Ada:1", "undefined:0"]);
		// The channel is still held by the other one, which saw no change.
		expect(kept).toEqual(["Ada:1"]);
		expect(other.others).toHaveLength(1);
	});

	test("a malformed state is ignored and the document keeps synchronizing", async () => {
		const { a, b, relay } = await pair();
		const theirs = joinPresence(b, Viewer);
		joinPresence(a, Viewer);
		const raw = relay.open(() => {});
		raw.receive(encodeMessage({ kind: 1, docId: a.id, requestId: 1, vv: [] }));
		raw.receive(
			encodePresenceFrame({
				docId: a.id,
				peer: 0,
				to: 0,
				event: PresenceEvent.state,
				subject: "",
				channel: Viewer.key,
				state: new Uint8Array([255, 255, 255]),
			}),
		);
		a.title = "Still synchronized";
		await eventually(() => expect(b.title).toBe("Still synchronized"));
		expect(theirs.others).toEqual([]);
		expect(getPulseMeta(b).status).not.toBe("error");
	});

	test("a destroyed pulse cannot be joined", async () => {
		const { a } = await pair();
		const mine = joinPresence(a, Viewer);
		destroyPulse(a);
		expect(mine.others).toEqual([]);
		expect(() => joinPresence(a, Viewer)).toThrow("destroyed");
	});
});

describe("presence frames", () => {
	const state = (bytes = new Uint8Array([1, 2, 3])) =>
		encodePresenceFrame({
			docId: "doc",
			peer: 0,
			to: 0,
			event: PresenceEvent.state,
			subject: "",
			channel: "cursor#abcd",
			state: bytes,
		});

	test("round trip and header", () => {
		const frame = state();
		expect([...frame.subarray(0, 3)]).toEqual([1, 3, 7]);
		expect(isPresenceFrame(frame)).toBe(true);
		expect(decodePresenceFrame(frame)).toEqual({
			docId: "doc",
			peer: 0,
			to: 0,
			event: 1,
			subject: "",
			channel: "cursor#abcd",
			state: new Uint8Array([1, 2, 3]),
		});
	});

	test("invalid frames are rejected", () => {
		expect(() => state(new Uint8Array(MAX_PRESENCE_BYTES + 1))).toThrow(
			"16 KiB",
		);
		const frame = decodePresenceFrame(state());
		expect(() => encodePresenceFrame({ ...frame, channel: "" })).toThrow();
		expect(() =>
			encodePresenceFrame({ ...frame, event: PresenceEvent.clear }),
		).toThrow();
		expect(() =>
			encodePresenceFrame({ ...frame, event: 4 as never }),
		).toThrow();
		expect(() => decodePresenceFrame(new Uint8Array([1, 3, 4, 0]))).toThrow();
		expect(() =>
			decodePresenceFrame(new Uint8Array([...state(), 0])),
		).toThrow();
	});

	test("a relay names the sender and refuses a client's leave", () => {
		const relayed = relayPresenceFrame(state(), { peer: 7, subject: "ada" });
		expect(relayed.docId).toBe("doc");
		expect(relayed.to).toBeUndefined();
		expect(decodePresenceFrame(relayed.frame)).toMatchObject({
			peer: 7,
			subject: "ada",
		});
		expect(() => relayPresenceFrame(state(), { peer: 0 })).toThrow();
		expect(() =>
			relayPresenceFrame(encodePresenceLeave("doc", 3), { peer: 7 }),
		).toThrow();
	});

	test("PulseRelay refuses presence before a connect", () => {
		const peer = new PulseRelay().open(() => {});
		expect(() => peer.receive(state())).toThrow("Connect to the document");
	});

	test("relayStoreMessage hands presence back instead of storing it", async () => {
		const store = {} as never; // Never touched by a presence frame.
		const result = await relayStoreMessage(store, state(), {
			docId: "doc",
			peer: 4,
			subject: "ada",
			readOnly: true,
		});
		expect(result.responses).toEqual([]);
		expect(result.broadcast).toBeUndefined();
		expect(decodePresenceFrame(result.presence!.frame)).toMatchObject({
			peer: 4,
			subject: "ada",
		});
		await expect(
			relayStoreMessage(store, state(), { docId: "other", peer: 4 }),
		).rejects.toThrow("One document");
		await expect(
			relayStoreMessage(store, state(), { docId: "doc" }),
		).rejects.toThrow("peer number");
	});
});
