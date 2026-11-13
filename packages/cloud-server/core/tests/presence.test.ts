import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	decodePresenceFrame,
	encodeMessage,
	encodePresenceFrame,
	isPresenceFrame,
	PresenceEvent,
} from "pulsify-core/protocol";
import {
	CloudRoot,
	presencePeer,
	SqliteCloudStorage,
	type CloudPeer,
} from "../source/index.js";

/** A root with in-memory sockets, as a host that just woke up would rebuild them. */
async function wake(
	connections: string[],
	subscribed = connections,
	/** Sockets whose client never sent presence: a client before version 10. */
	old: string[] = [],
) {
	const storage = new SqliteCloudStorage(new Database(":memory:"));
	await storage.putGrant({ subject: "*", prefix: "root", role: "reader" });
	for (const connection of subscribed)
		await storage.saveSubscription({
			connection,
			docId: "root/doc",
			role: "reader",
		});
	const sent = new Map<string, (Uint8Array | string)[]>();
	const peers = new Map<string, CloudPeer>();
	for (const id of connections) {
		sent.set(id, []);
		const peer: CloudPeer = {
			id,
			subject: `user-${id}`,
			envelope: 2,
			presence: !old.includes(id),
			usePresence: () => void peers.set(id, { ...peer, presence: true }),
			subscriptions: new Map(),
			keepSubscriptions: () => true,
			send: (data) => void sent.get(id)!.push(data),
			close: () => {},
		};
		peers.set(id, peer);
	}
	const root = new CloudRoot("root", storage, {
		get: (id) => peers.get(id),
		all: () => peers.values(),
	});
	const presence = (id: string) =>
		sent
			.get(id)!
			.filter(
				(data): data is Uint8Array =>
					typeof data !== "string" && isPresenceFrame(data),
			)
			.map(decodePresenceFrame);
	const sentTo = (id: string) => sent.get(id)!;
	return { root, peers, presence, storage, sentTo };
}
const state = (to = 0, docId = "root/doc") =>
	encodePresenceFrame({
		docId,
		peer: 0,
		to,
		event: PresenceEvent.state,
		subject: "",
		channel: "cursor#abcd",
		state: new Uint8Array([1]),
	});

test("peer numbers are stable, positive and distinct", () => {
	const ids = Array.from({ length: 2_000 }, () => crypto.randomUUID());
	const numbers = ids.map(presencePeer);
	expect(new Set(numbers).size).toBe(ids.length);
	expect(numbers.every((n) => Number.isSafeInteger(n) && n > 0)).toBe(true);
	expect(presencePeer(ids[0]!)).toBe(numbers[0]!);
});

test("after hibernation, subscriptions and peer numbers still route presence", async () => {
	const { root, peers, presence } = await wake(["a", "b", "c"]);
	// No connect since the wake-up: the subscriptions come from storage.
	await root.receive(peers.get("a")!, state());
	expect(presence("a")).toEqual([]);
	for (const other of ["b", "c"])
		expect(presence(other)).toMatchObject([
			{ peer: presencePeer("a"), subject: "user-a", event: 1 },
		]);
	// An answer to one newcomer reaches only that peer.
	await root.receive(peers.get("b")!, state(presencePeer("c")));
	expect(presence("a")).toEqual([]);
	expect(presence("c")).toHaveLength(2);
});

test("a socket that closed while the root slept is announced on wake-up", async () => {
	const { root, presence } = await wake(["a"], ["a", "gone"]);
	await root.roleOf("anyone", "root/doc");
	expect(presence("a")).toMatchObject([
		{ peer: presencePeer("gone"), event: PresenceEvent.leave },
	]);
});

test("presence without a subscription is dropped, and a client's leave is a violation", async () => {
	const { root, peers, presence } = await wake(["a", "b"], ["b"]);
	let closed = 0;
	const a = { ...peers.get("a")!, close: () => void closed++ };
	await root.receive(a, state());
	expect(presence("b")).toEqual([]);
	expect(closed).toBe(0);
	await root.receive(
		a,
		encodeMessage({ kind: 1, docId: "root/doc", requestId: 1, vv: [] }),
	);
	await root.receive(
		a,
		encodePresenceFrame({
			docId: "root/doc",
			peer: 0,
			to: 0,
			event: PresenceEvent.leave,
			subject: "",
			channel: "",
			state: new Uint8Array(),
		}),
	);
	expect(closed).toBe(1);
	// Closing it announced its departure to the other session.
	expect(presence("b").at(-1)).toMatchObject({
		peer: presencePeer("a"),
		event: PresenceEvent.leave,
	});
});

test("a client that never sent presence receives none, until it does", async () => {
	const { root, peers, presence, sentTo } = await wake(
		["a", "b", "old"],
		undefined,
		["old"],
	);
	await root.receive(peers.get("a")!, state());
	expect(presence("b")).toHaveLength(1);
	expect(sentTo("old")).toEqual([]);
	// Its departure is not announced to it either.
	await root.disconnect(peers.get("a")!);
	expect(presence("b").at(-1)).toMatchObject({ event: PresenceEvent.leave });
	expect(sentTo("old")).toEqual([]);
	// Once it uses presence, it is a recipient like the others.
	await root.receive(peers.get("old")!, state());
	await root.receive(peers.get("b")!, state());
	expect(presence("old")).toMatchObject([{ peer: presencePeer("b") }]);
});

test("a root forwards 200 presence frames per socket and second, then drops", async () => {
	const { root, peers, presence } = await wake(["a", "b"]);
	const now = Date.now;
	try {
		Date.now = () => 2_000_000;
		for (let i = 0; i < 201; i++) await root.receive(peers.get("a")!, state());
		expect(presence("b")).toHaveLength(200);
		Date.now = () => 2_001_000;
		await root.receive(peers.get("a")!, state());
		expect(presence("b")).toHaveLength(201);
	} finally {
		Date.now = now;
	}
});

test("presence stops with the subscription: unsubscribe and revocation", async () => {
	const { root, peers, presence, sentTo } = await wake(["a", "b", "c"]);
	await root.receive(
		peers.get("a")!,
		JSON.stringify({ type: "unsubscribe", docId: "root/doc" }),
	);
	expect(presence("b")).toMatchObject([
		{ peer: presencePeer("a"), event: PresenceEvent.leave },
	]);
	// Its socket is still open, but it no longer sends to the document.
	await root.receive(peers.get("a")!, state());
	expect(presence("b")).toHaveLength(1);
	expect(presence("a")).toEqual([]);
	// Nor receives from it.
	await root.receive(peers.get("b")!, state());
	expect(presence("a")).toEqual([]);
	expect(presence("c")).toHaveLength(2);

	// Revoking the grant cuts the others the same way.
	const revoked = await root.handleRequest(
		"grants",
		new Request("https://root/grants?subject=*&prefix=root", {
			method: "DELETE",
		}),
		{ kind: "admin" },
	);
	expect(await revoked.json()).toEqual({ removed: true });
	expect(
		sentTo("b").some(
			(data) => typeof data === "string" && data.includes('"role":null'),
		),
	).toBe(true);
	const before = presence("c").length;
	await root.receive(peers.get("b")!, state());
	expect(presence("c")).toHaveLength(before);
});

test("presence cannot leave its root or its document", async () => {
	const { root, peers, presence, sentTo } = await wake(["a", "b"]);
	// A document of another root: refused, and nobody hears of it.
	await root.receive(peers.get("a")!, state(0, "elsewhere/doc"));
	expect(presence("b")).toEqual([]);
	expect(
		sentTo("a").some((data) => typeof data !== "string" && data[2] === 6),
	).toBe(true);
	// A document of this root the socket is not subscribed to: dropped.
	await root.receive(peers.get("a")!, state(0, "root/other"));
	expect(presence("b")).toEqual([]);
	// A target that is in another document only gets nothing.
	const elsewhere = await wake(["a", "b"], ["a"]);
	await elsewhere.storage.saveSubscription({
		connection: "b",
		docId: "root/other",
		role: "reader",
	});
	await elsewhere.root.receive(
		elsewhere.peers.get("a")!,
		state(presencePeer("b")),
	);
	expect(elsewhere.presence("b")).toEqual([]);
});
