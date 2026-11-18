import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { array, object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	getPulseVersions,
	restorePulse,
	richText,
	snapshotPulse,
	versioned,
	type Pulse,
} from "pulsify-core";
import { createCloudClient, type CloudClient } from "pulsify-cloud";
import { CloudRoot, SqliteCloudStorage } from "../source/index.js";

const Note = definePulse(
	"SnapshotNote",
	object({
		title: "string",
		status: versioned("string"),
		body: richText(),
		tags: array("string"),
	}),
).materialize();

/** A root in memory, and management clients whose requests go straight to it. */
async function fixture() {
	const db = new Database(":memory:"),
		storage = new SqliteCloudStorage(db);
	for (const [subject, role] of [
		["olga", "owner"],
		["eve", "editor"],
		["rita", "reader"],
	] as const)
		await storage.putGrant({ subject, prefix: "r", role });
	const root = new CloudRoot("r", storage, {
		get: () => undefined,
		all: () => [],
	});
	const client = (credential: string): CloudClient =>
		createCloudClient({
			url: "https://test",
			credential,
			fetch: ((input: URL, init: RequestInit) =>
				root.handleRequest(
					"snapshots",
					new Request(input, init),
					credential === "key"
						? { kind: "admin" }
						: { kind: "user", subject: credential },
				)) as unknown as typeof fetch,
		});
	const note = createPulse(
		Note,
		{
			id: "r/note",
			title: "Draft",
			status: "open",
			body: "Hello",
			tags: ["a"],
		},
		{ scope: createPulseScope(), sessionId: 65536 },
	);
	/** What a connected client does: send the rows the server lacks. */
	const upload = async (pulse: Pulse<any> = note) => {
		const log = getPulseMeta(pulse).log;
		await storage.patches.append(
			log.missing(await storage.patches.vector(pulse.id)),
		);
	};
	return { db, storage, root, client, note, upload };
}

test("an editor snapshots a document, a reader opens it, and it restores", async () => {
	const f = await fixture();
	const { note } = f;
	note.body.format(0, 5, { bold: true });
	await f.upload();
	const saved = await f.client("eve").snapshot("r/note", { label: "Sent" });
	expect(saved).toMatchObject({
		docId: "r/note",
		label: "Sent",
		subject: "eve",
		version: getPulseVersions(note).state,
	});
	expect(saved.time).toBeGreaterThan(Date.now() - 5_000);

	note.title = "Final";
	note.status = "done";
	note.tags.push("b");
	note.body.insert(5, " world");
	await f.upload();
	// Snapshots are listed by the server's clock: let it move.
	await new Promise((resolve) => setTimeout(resolve, 5));
	const later = await f.client("key").snapshot("r/note");
	expect(later.subject).toBeUndefined();
	expect(later.label).toBeUndefined();

	const listed = await f.client("rita").snapshots("r/note");
	expect(listed).toEqual([saved, later]);
	expect(
		await f.client("rita").snapshots("r/note", { since: new Date(later.time) }),
	).toEqual([later]);
	expect(
		await f.client("rita").snapshots("r/note", {
			since: new Date(later.time + 1),
		}),
	).toEqual([]);

	const old = await f.client("rita").loadSnapshot(Note, "r/note", saved.id);
	expect(snapshotPulse(old)).toMatchObject({
		title: "Draft",
		status: "open",
		body: "Hello",
		tags: ["a"],
	});
	expect(() => {
		old.title = "x";
	}).toThrow(/read-only/);
	// The live document is another pulse, and unchanged so far.
	expect(note.title).toBe("Final");

	restorePulse(note, old);
	destroyPulse(old);
	expect(snapshotPulse(note)).toMatchObject({
		generation: 1,
		title: "Draft",
		status: "open",
		body: "Hello",
		tags: ["a"],
	});
	expect(note.body.toDelta()).toEqual([
		{ insert: "Hello", attributes: { bold: true } },
	]);
	// The restore is uploaded like any edit, and the next snapshot holds it.
	await f.upload();
	const restored = await f.client("eve").snapshot("r/note");
	const again = await f.client("eve").loadSnapshot(Note, "r/note", restored.id);
	expect(snapshotPulse(again)).toEqual(snapshotPulse(note));
});

test("roles: an editor creates, a reader reads, an owner erases", async () => {
	const f = await fixture();
	await f.upload();
	await expect(f.client("rita").snapshot("r/note")).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(f.client("nobody").snapshots("r/note")).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(f.client("eve").snapshot("r/missing")).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	await expect(f.client("eve").snapshot("other/note")).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
	await expect(
		f.client("eve").snapshot("r/note", { label: "x".repeat(257) }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	const saved = await f.client("eve").snapshot("r/note");
	await expect(
		f.client("nobody").loadSnapshot(Note, "r/note", saved.id),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		f.client("rita").loadSnapshot(Note, "r/note", "unknown"),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		f.client("eve").deleteSnapshot("r/note", saved.id),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(await f.client("olga").deleteSnapshot("r/note", saved.id)).toBe(true);
	expect(await f.client("olga").deleteSnapshot("r/note", saved.id)).toBe(false);
	expect(await f.client("rita").snapshots("r/note")).toEqual([]);
});

test("a snapshot is stored in frames a host can hold, and goes with its document", async () => {
	const f = await fixture();
	const { note } = f;
	// Three versioned writes of 400 KiB: more than one stored frame.
	for (const letter of ["a", "b", "c"]) note.status = letter.repeat(400 * 1024);
	// A write that replaces another one: the document has to be copied.
	note.title = "Renamed";
	await f.upload();
	const before = (await f.storage.usage()).bytes;
	const saved = await f.client("eve").snapshot("r/note");
	const frames = f.db
		.query("SELECT length(frame) AS size FROM pulsify_cloud_snapshot_frames")
		.all() as { size: number }[];
	expect(frames.length).toBeGreaterThan(1);
	for (const { size } of frames) expect(size).toBeLessThan(2_000_000);
	expect((await f.storage.usage()).bytes).toBeGreaterThan(before + 1024 * 1024);
	const old = await f.client("rita").loadSnapshot(Note, "r/note", saved.id);
	expect(old.status).toBe("c".repeat(400 * 1024));

	// Deleting the document erases its snapshots.
	const deleted = await f.root.handleRequest(
		"documents",
		new Request("https://test/documents?docId=r/note", { method: "DELETE" }),
		{ kind: "admin" },
	);
	expect(deleted.status).toBe(200);
	for (const table of ["snapshots", "snapshot_frames"])
		expect(
			f.db.query(`SELECT COUNT(*) AS n FROM pulsify_cloud_${table}`).get(),
		).toEqual({ n: 0 });
	await expect(f.client("eve").snapshot("r/note")).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
});

test("a document that keeps every write is snapshotted by its version alone", async () => {
	const f = await fixture();
	const { note } = f;
	// Text edits and versioned writes: no write replaces another.
	for (let i = 0; i < 50; i++) note.status = `step ${i}`;
	note.body.insert(5, " world");
	await f.upload();
	const saved = await f.client("eve").snapshot("r/note");
	expect(saved.version).toEqual(getPulseVersions(note).state);
	expect(
		f.db.query("SELECT COUNT(*) AS n FROM pulsify_cloud_snapshot_frames").get(),
	).toEqual({ n: 0 });

	// The document moves on, with writes that replace each other this time.
	note.status = "later";
	note.title = "Renamed";
	note.title = "Renamed again";
	note.body.insert(0, ">> ");
	await f.upload();
	const old = await f.client("rita").loadSnapshot(Note, "r/note", saved.id);
	expect(snapshotPulse(old)).toMatchObject({
		title: "Draft",
		status: "step 49",
		body: "Hello world",
	});
	// The client restores it by naming the version: a few bytes.
	const rows = () => getPulseMeta(note).log.missing([]);
	const before = rows().length;
	restorePulse(note, old);
	destroyPulse(old);
	expect(rows()).toHaveLength(before + 1);
	expect(rows().at(-1)!.operations.length).toBeLessThan(64);
	expect(snapshotPulse(note)).toMatchObject({
		generation: 1,
		title: "Draft",
		status: "step 49",
		body: "Hello world",
	});
	// A later snapshot of the same document is a copy.
	await f.upload();
	await f.client("eve").snapshot("r/note");
	expect(
		(
			f.db
				.query("SELECT COUNT(*) AS n FROM pulsify_cloud_snapshot_frames")
				.get() as { n: number }
		).n,
	).toBeGreaterThan(0);
	expect(await f.client("olga").deleteSnapshot("r/note", saved.id)).toBe(true);
	await expect(
		f.client("rita").loadSnapshot(Note, "r/note", saved.id),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});
