import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	decodeMessage,
	definePulse,
	encodeMessage,
	getPulseHistory,
	getPulseMeta,
	versioned,
	type Pulse,
	type PulseMessage,
} from "pulsify-core";
import { defaultPulseOptions } from "../../../pulse/source/pulses/PulseOptions.js";
import { createRuntime } from "../../../pulse/source/pulses/PulseRuntime.js";
import type { StoredPatchRow } from "pulsify-core/storage";
import {
	createCloudClient,
	parseCloudPath,
	type CloudAction,
	type CloudClient,
} from "pulsify-cloud";
import {
	CloudRoot,
	SqliteCloudStorage,
	type CloudPeer,
} from "../source/index.js";

const Note = definePulse(
	"AuthoredNote",
	versioned(object({ title: "string", status: "string" })),
).materialize();

const ALICE = 70_001,
	BOB = 70_002,
	CAROL = 70_003;

/** A root in memory, sockets that record what they receive, and API clients. */
async function fixture() {
	const db = new Database(":memory:"),
		storage = new SqliteCloudStorage(db);
	for (const [subject, role] of [
		["olga", "owner"],
		["alice", "editor"],
		["bob", "editor"],
		["rita", "reader"],
	] as const)
		await storage.putGrant({ subject, prefix: "r", role });
	const peers = new Map<string, CloudPeer>();
	const root = new CloudRoot("r", storage, {
		get: (id) => peers.get(id),
		all: () => peers.values(),
	});
	let requestId = 1;
	/** An authenticated socket: only its subject comes from the server. */
	const socket = (subject: string) => {
		const sent: (Uint8Array | string)[] = [];
		const peer: CloudPeer = {
			id: crypto.randomUUID(),
			subject,
			envelope: 2,
			presence: false,
			usePresence() {},
			subscriptions: new Map(),
			keepSubscriptions: () => true,
			send: (data) => void sent.push(data),
			close() {},
		};
		peers.set(peer.id, peer);
		const frames = () =>
			sent
				.filter((data): data is Uint8Array => typeof data !== "string")
				.map((data) => decodeMessage(data));
		return {
			peer,
			/** The control messages received, without the roles. */
			texts: () =>
				sent
					.filter((data): data is string => typeof data === "string")
					.map((data) => JSON.parse(data))
					.filter((message) => message.type !== "role"),
			connect: (docId: string) =>
				root.receive(
					peer,
					encodeMessage({ kind: 1, docId, requestId: requestId++, vv: [] }),
				),
			claim: (docId: string, actors: number[]) =>
				root.receive(peer, JSON.stringify({ type: "actors", docId, actors })),
			/** Upload rows, and resolve to the answer: an ack or an error. */
			async upload(rows: StoredPatchRow[]): Promise<PulseMessage> {
				const id = requestId++;
				await root.receive(
					peer,
					encodeMessage({
						kind: 3,
						docId: rows[0]!.docId,
						requestId: id,
						vv: [],
						rows,
					}),
				);
				return frames().find((frame) => frame.requestId === id)!;
			},
		};
	};
	const client = (credential: string): CloudClient =>
		createCloudClient({
			url: "https://test",
			credential,
			fetch: ((input: URL, init: RequestInit) =>
				root.handleRequest(
					parseCloudPath(input.pathname)!.action as Exclude<
						CloudAction,
						"connect"
					>,
					new Request(input, init),
					credential === "key"
						? { kind: "admin" }
						: { kind: "user", subject: credential },
				)) as unknown as typeof fetch,
		});
	return { db, storage, root, socket, client };
}

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const rowsOf = (pulse: Pulse<any>) => getPulseMeta(pulse).log.missing([]);
/** The first replica of `r/note`, which creates it under `actor`. */
const create = (actor: number) =>
	createPulse(
		Note,
		{ id: "r/note", title: "Draft", status: "open" },
		options(actor),
	);
/** Another replica, writing under `actor`, that holds what `source` holds. */
const join = (source: Pulse<any>, actor: number) => {
	const pulse = createRuntime(Note, "r/note", options(actor));
	getPulseMeta(pulse).applyRows(rowsOf(source));
	return pulse as ReturnType<typeof create>;
};
/** Give `target` what it lacks from `source`. */
const sync = (source: Pulse<any>, target: Pulse<any>) => {
	const missing = getPulseMeta(source).log.missing(
		getPulseMeta(target).log.vector,
	);
	if (missing.length) getPulseMeta(target).applyRows(missing);
};
/** Who the server says wrote each transaction, as `actor:clock subject`. */
const authorship = async (cloud: CloudClient, pulse: Pulse<any>) => {
	const authors = await cloud.authors("r/note");
	return getPulseHistory(pulse).map((version) => {
		const { subject, receivedFrom, verified } = authors.of(version);
		return `${version.actor}:${version.clock} ${subject ?? "-"} ${receivedFrom ?? "-"} ${verified ? "verified" : "unverified"}`;
	});
};

test("an actor is the account of the token that declared it, and its writes are that account's", async () => {
	const f = await fixture();
	const alice = f.socket("alice"),
		bob = f.socket("bob");
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	expect((await alice.upload(rowsOf(note))).kind).toBe(5);
	const theirs = join(note, BOB);
	theirs.status = "done";
	await bob.connect("r/note");
	await bob.claim("r/note", [BOB]);
	expect((await bob.upload(rowsOf(theirs))).kind).toBe(5);
	expect(alice.texts()).toEqual([]);

	// The lookup: an actor of the history, the user behind it.
	const reader = f.client("rita");
	const [first, second] = getPulseHistory(theirs);
	expect(first!.actor).toBe(ALICE);
	expect(second!.actor).toBe(BOB);
	expect(await reader.actorSubject("r/note", first!.actor)).toBe("alice");
	expect(await reader.actorSubject("r/note", second!.actor)).toBe("bob");
	expect(await reader.actorSubject("r/note", CAROL)).toBeUndefined();
	expect(await authorship(reader, theirs)).toEqual([
		`${ALICE}:1 alice alice verified`,
		`${BOB}:1 bob bob verified`,
	]);
	expect((await reader.authors("r/note")).actors).toEqual(
		new Map([
			[ALICE, "alice"],
			[BOB, "bob"],
		]),
	);
});

test("rows relayed by another account are never its own, nor their actor's, and a late claim changes nothing", async () => {
	const f = await fixture();
	const alice = f.socket("alice"),
		bob = f.socket("bob");
	// Alice wrote offline; Bob received her rows another way and uploads them
	// with his own. He declares his actor only.
	const note = create(ALICE);
	const theirs = join(note, BOB);
	theirs.status = "done";
	await bob.connect("r/note");
	await bob.claim("r/note", [BOB]);
	expect((await bob.upload(rowsOf(theirs))).kind).toBe(5);
	const cloud = f.client("key");
	expect(await cloud.actorSubject("r/note", ALICE)).toBeUndefined();
	expect(await authorship(cloud, theirs)).toEqual([
		`${ALICE}:1 - bob unverified`,
		`${BOB}:1 bob bob verified`,
	]);

	// Alice comes back: her actor is hers from now on. The rows the server
	// already holds are sent again and keep the account they came from.
	note.title = "Final";
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	expect((await alice.upload(rowsOf(note))).kind).toBe(5);
	sync(note, theirs);
	expect(await cloud.actorSubject("r/note", ALICE)).toBe("alice");
	expect(await authorship(cloud, theirs)).toEqual([
		`${ALICE}:1 alice bob unverified`,
		// Written apart: transactions of one time go by actor.
		`${ALICE}:2 alice alice verified`,
		`${BOB}:1 bob bob verified`,
	]);

	// A known actor relayed by another account: still not that account's.
	note.status = "archived";
	sync(note, theirs);
	expect((await bob.upload(rowsOf(theirs))).kind).toBe(5);
	expect((await authorship(cloud, theirs)).at(-1)).toBe(
		`${ALICE}:3 alice bob unverified`,
	);
});

test("an actor that has an account cannot be claimed or forged by another", async () => {
	const f = await fixture();
	const alice = f.socket("alice"),
		bob = f.socket("bob");
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	await alice.upload(rowsOf(note));

	// Bob claims her actor: refused, and the binding stays.
	await bob.connect("r/note");
	await bob.claim("r/note", [ALICE, BOB]);
	expect(bob.texts()).toEqual([
		{ type: "actors", docId: "r/note", refused: [ALICE] },
	]);
	const cloud = f.client("key");
	expect(await cloud.actorSubject("r/note", ALICE)).toBe("alice");
	expect(await cloud.actorSubject("r/note", BOB)).toBe("bob");

	// Bob writes under her actor: stored, since the rows are valid, and
	// attributed to nobody. Never to Alice.
	const forged = join(note, ALICE);
	getPulseMeta(forged).model.nextClock = 2;
	forged.title = "Forged";
	expect((await bob.upload(rowsOf(forged))).kind).toBe(5);
	expect(await authorship(cloud, forged)).toEqual([
		`${ALICE}:1 alice alice verified`,
		`${ALICE}:2 alice bob unverified`,
	]);
	expect(await cloud.actorSubject("r/note", ALICE)).toBe("alice");
});

test("a reader cannot claim, and a claim names no account", async () => {
	const f = await fixture();
	const rita = f.socket("rita"),
		alice = f.socket("alice");
	await rita.connect("r/note");
	await rita.claim("r/note", [ALICE]);
	// Not heard, and not answered: a reader learns nothing about actors.
	expect(rita.texts()).toEqual([]);
	expect(await f.storage.actorSubjects([ALICE])).toEqual(new Map());
	// Nothing was bound: the actor is still free for the account that writes.
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	await alice.upload(rowsOf(note));
	expect(await f.client("key").actorSubject("r/note", ALICE)).toBe("alice");
	// A subject sent by a client is no part of the message: it is ignored.
	await f.root.receive(
		alice.peer,
		JSON.stringify({
			type: "actors",
			docId: "r/note",
			actors: [CAROL],
			subject: "bob",
		}),
	);
	expect(
		[...(await f.storage.actorSubjects([CAROL]))].map(([, subject]) => subject),
	).toEqual(["alice"]);
});

test("a refused append records nothing, and what waits for its history keeps its sender", async () => {
	const f = await fixture();
	const alice = f.socket("alice"),
		bob = f.socket("bob");
	const note = create(ALICE);
	note.title = "One";
	note.title = "Two";
	const [first, second, third] = rowsOf(note);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	await alice.upload([first!]);
	const received = () => f.storage.received("r/note");
	expect(await received()).toEqual([
		{ actor: ALICE, clock: 1, end: 2, subject: "alice" },
	]);

	// A valid new row, then one that conflicts with what is stored: the
	// whole upload is refused, the valid row with it.
	const conflicting = { ...first!, operations: second!.operations };
	await bob.connect("r/note");
	expect((await bob.upload([second!, conflicting])).kind).toBe(6);
	expect(await f.storage.patches.vector("r/note")).toEqual([[ALICE, 2]]);
	expect(await received()).toEqual([
		{ actor: ALICE, clock: 1, end: 2, subject: "alice" },
	]);

	// What the store calls back with runs in its transaction: if it fails,
	// the rows are not stored either.
	await expect(
		f.storage.patches.append([second!], () => {
			throw new Error("not recorded");
		}),
	).rejects.toThrow("not recorded");
	expect(await f.storage.patches.vector("r/note")).toEqual([[ALICE, 2]]);
	expect(await f.storage.patches.missing("r/note", [[ALICE, 2]])).toEqual([]);

	// Out of order: Bob relays the third row, which waits for the second.
	expect((await bob.upload([third!])).kind).toBe(5);
	expect(await f.storage.patches.vector("r/note")).toEqual([[ALICE, 2]]);
	// Alice sends the second, and the third again: it stays Bob's delivery.
	expect((await alice.upload([second!, third!])).kind).toBe(5);
	expect(await f.storage.patches.vector("r/note")).toEqual([[ALICE, 4]]);
	expect(await received()).toEqual([
		{ actor: ALICE, clock: 1, end: 3, subject: "alice" },
		{ actor: ALICE, clock: 3, end: 4, subject: "bob" },
	]);
	expect(await authorship(f.client("key"), note)).toEqual([
		`${ALICE}:1 alice alice verified`,
		`${ALICE}:2 alice alice verified`,
		`${ALICE}:3 alice bob unverified`,
	]);
});

test("authors survive compaction, and uploads as a client writes stay one range", async () => {
	const f = await fixture();
	const alice = f.socket("alice");
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	let sent = 0;
	for (let i = 0; i < 200; i++) {
		note.status = `step ${i}`;
		const rows = rowsOf(note);
		expect((await alice.upload(rows.slice(sent))).kind).toBe(5);
		sent = rows.length;
	}
	expect(await f.storage.received("r/note")).toEqual([
		{ actor: ALICE, clock: 1, end: 202, subject: "alice" },
	]);
	const before = await authorship(f.client("key"), note);
	const { rows } = await f.storage.patches.compact({ minRows: 2 });
	expect(rows).toBeGreaterThan(100);
	// A client that loads the packed history reads the same authors.
	const loaded = createRuntime(Note, "r/note", options(BOB));
	getPulseMeta(loaded).applyRows(await f.storage.patches.missing("r/note", []));
	const after = await authorship(f.client("rita"), loaded);
	expect(after).toEqual(before);
	expect(after).toHaveLength(201);
	expect(
		new Set(after.map((line) => line.split(" ").slice(1).join(" "))),
	).toEqual(new Set(["alice alice verified"]));
});

test("only readers of a document read who wrote it, and only about its own actors", async () => {
	const f = await fixture();
	await f.storage.putGrant({
		subject: "dan",
		prefix: "r/other",
		role: "editor",
	});
	const alice = f.socket("alice"),
		dan = f.socket("dan");
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	await alice.upload(rowsOf(note));
	const other = createPulse(
		Note,
		{ id: "r/other", title: "Other", status: "open" },
		options(CAROL),
	);
	await dan.connect("r/other");
	await dan.claim("r/other", [CAROL]);
	await dan.upload(rowsOf(other));

	// Dan reads `r/other` only: nothing about `r/note`, and nothing about
	// Alice's actor through the document he can read.
	const outsider = f.client("dan");
	await expect(outsider.actorSubject("r/note", ALICE)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(outsider.authors("r/note")).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(await outsider.actorSubject("r/other", ALICE)).toBeUndefined();
	expect(await outsider.actorSubject("r/other", CAROL)).toBe("dan");
	expect((await outsider.authors("r/other")).actors).toEqual(
		new Map([[CAROL, "dan"]]),
	);
	// The API key reads every actor of the root, from any of its documents.
	expect(await f.client("key").actorSubject("r/other", ALICE)).toBe("alice");
	await expect(
		f.client("rita").actorSubject("r/note", 12),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	// A claim on a document a session cannot write is not heard.
	await dan.claim("r/note", [BOB, ALICE]);
	expect(dan.texts()).toEqual([]);
	expect(await f.storage.actorSubjects([BOB])).toEqual(new Map());
	// The API key needs no live document to ask about an actor of the root.
	await f.client("olga").deleteDocument("r/note");
	expect(await f.client("key").actorSubject("r/note", ALICE)).toBe("alice");
});

test("deleting a document erases who wrote it, and deleting the root its actors", async () => {
	const f = await fixture();
	const alice = f.socket("alice");
	const note = create(ALICE);
	await alice.connect("r/note");
	await alice.claim("r/note", [ALICE]);
	await alice.upload(rowsOf(note));
	const count = (table: string) =>
		(
			f.db
				.query(`SELECT COUNT(*) AS count FROM pulsify_cloud_${table}`)
				.get() as {
				count: number;
			}
		).count;
	expect([count("actors"), count("received")]).toEqual([1, 1]);
	await f.client("olga").deleteDocument("r/note");
	// The actor still belongs to the root, where it may have written elsewhere.
	expect([count("actors"), count("received")]).toEqual([1, 0]);
	await expect(
		f.client("rita").actorSubject("r/note", ALICE),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(f.client("key").authors("r/note")).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	await f.client("key").deleteDocument("r");
	expect([count("actors"), count("received")]).toEqual([0, 0]);
});
