import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { array, object } from "@gin-quin/codec";
import {
	connectPulse,
	decodeMessage,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	richText,
	relayStoreMessage,
	snapshotPulse,
	sub,
	pulseRef,
	versioned,
	type Connector,
	type Pulse,
} from "pulsify-core";
import {
	isGap,
	lastRegisterOf,
	SQLITE_PATCH_SCHEMA,
	SqlitePatchStore,
	type StoredPatchRow,
} from "pulsify-core/storage";
import { createTauriConnector } from "../source/index";
import {
	createStorePlugin,
	downloadRows,
	openUploader,
	RustPlugin,
	rustManifest,
	type FakePlugin,
} from "./plugins";

// Builds the real Rust hub (incremental after the first run) when cargo is available.
const cargo = Bun.which("cargo");
if (!cargo)
	console.warn(
		"Skipping the pulsify-tauri Rust interoperability tests: cargo is not installed.",
	);
else {
	const build = Bun.spawnSync([
		cargo,
		"build",
		"--locked",
		"--quiet",
		"--manifest-path",
		rustManifest,
	]);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}
const directory = mkdtempSync(join(tmpdir(), "pulsify-tauri-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const timeout = 60_000;

const Note = definePulse(
	"TauriRustNote",
	object({
		title: "string",
		body: richText(),
		tags: array("string"),
		// Every write is kept: consecutive ones travel as one grouped run.
		stats: versioned(object({ views: "float64" })),
	}),
).materialize();
const Workspace = definePulse(
	"TauriRustWorkspace",
	object({ name: "string", notes: array(sub(Note)) }),
).materialize();

/** A fresh synchronization uploads every local row. */
async function flush(...pulses: Pulse<any>[]) {
	for (const pulse of pulses) disconnectPulse(pulse);
	await Promise.all(pulses.map((pulse) => connectPulse(pulse).synced));
}
function createWorkspace(id: string, connector: Connector) {
	const scope = createPulseScope();
	const workspace = createPulse(
		Workspace,
		{ id, name: "Team", notes: [] },
		{ scope, connectors: [connector] },
	);
	const note = createPulse(
		Note,
		{ title: "Plan", body: "Draft", tags: ["a"], stats: { views: 0 } },
		{ parent: workspace },
	);
	workspace.notes.push(pulseRef(note));
	return { workspace, note };
}
async function edit(
	note: ReturnType<typeof createWorkspace>["note"],
	...pulses: Pulse<any>[]
) {
	note.body.insert(5, " 🌍 written in Rust's store");
	note.tags.push("b", "c");
	await flush(note, ...pulses);
	// Consecutive writes of one scalar travel as one grouped (envelope 2) run.
	for (let i = 1; i <= 100; i++) note.stats.views = i;
	await flush(note, ...pulses);
}
async function loadWorkspace(id: string, connector: Connector) {
	const workspace = await loadPulse(Workspace, id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	const note = workspace.notes[0]!.pulse!;
	return { workspace, note };
}
const byKey = (rows: StoredPatchRow[]) =>
	[...rows].sort((a, b) => a.sid - b.sid || a.clock - b.clock);
async function eventually(assertion: () => void, limit = 5000) {
	const end = performance.now() + limit;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** Every row, value and clock of a database file, in key order. */
function tables(db: Database) {
	return {
		rows: db
			.query(
				"SELECT doc_id,sid,time_start,span,dependencies,lower(hex(operations)) AS operations,ready,packed FROM pulsify_op_rows ORDER BY doc_id,sid,time_start",
			)
			.all(),
		values: db
			.query(
				"SELECT doc_id,sid,lower(hex(register)) AS register,clock,dependencies,lower(hex(operations)) AS operations FROM pulsify_values ORDER BY doc_id,sid,register",
			)
			.all(),
		clocks: db
			.query(
				"SELECT doc_id,sid,clock FROM pulsify_doc_clocks ORDER BY doc_id,sid",
			)
			.all(),
	};
}
/**
 * Last-value rows are kept as values, each under the register its write
 * names, and only there: the ready rows are history rows. How many values.
 */
function expectValues(db: Database) {
	const values = db
		.query("SELECT register,operations FROM pulsify_values")
		.all() as { register: Uint8Array; operations: Uint8Array }[];
	for (const value of values)
		expect(
			hex(lastRegisterOf(new Uint8Array(value.operations))!.register),
		).toBe(hex(new Uint8Array(value.register)));
	const ready = db
		.query("SELECT operations FROM pulsify_op_rows WHERE ready=1 AND packed=0")
		.all() as { operations: Uint8Array }[];
	for (const row of ready) {
		const operations = new Uint8Array(row.operations);
		expect(isGap(operations) || !!lastRegisterOf(operations)).toBe(false);
	}
	return values.length;
}
/** How many rows and values a document holds. */
function rowCount(db: Database, docId: string) {
	return (
		db
			.query(
				"SELECT (SELECT COUNT(*) FROM pulsify_op_rows WHERE doc_id=?1) + (SELECT COUNT(*) FROM pulsify_values WHERE doc_id=?1) AS n",
			)
			.get(docId) as { n: number }
	).n;
}
/** Served rows that a store holds: not the gap rows that stand for replaced writes. */
const heldRows = (rows: StoredPatchRow[]) =>
	rows.filter((row) => !isGap(row.operations));

describe.skipIf(!cargo)("Rust SQLite hub", () => {
	test("uses the TypeScript SQLITE_PATCH_SCHEMA", async () => {
		const rust = new RustPlugin(join(directory, "schema.sqlite"));
		expect(await rust.schema()).toBe(SQLITE_PATCH_SCHEMA);
		expect(await rust.stop()).toBe(0);
	});

	test(
		"documents, rich text, arrays and sub-pulses survive a restart",
		async () => {
			const path = join(directory, "restart.sqlite");
			let rust = new RustPlugin(path);
			const { workspace, note } = createWorkspace(
				"restart",
				createTauriConnector(rust),
			);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			await edit(note, workspace);
			const expected = [snapshotPulse(workspace), snapshotPulse(note)];
			destroyPulse(note);
			destroyPulse(workspace);
			expect(await rust.stop()).toBe(0);

			rust = new RustPlugin(path);
			const loaded = await loadWorkspace("restart", createTauriConnector(rust));
			expect([
				snapshotPulse(loaded.workspace),
				snapshotPulse(loaded.note),
			]).toEqual(expected);
			expect(loaded.note.body.toString()).toBe(
				"Draft 🌍 written in Rust's store",
			);
			expect([...loaded.note.tags]).toEqual(["a", "b", "c"]);
			expect(loaded.note.stats.views).toBe(100);
			destroyPulse(loaded.note);
			destroyPulse(loaded.workspace);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);

	test(
		"a file written by Rust is read and extended by SqlitePatchStore",
		async () => {
			const path = join(directory, "rust-first.sqlite");
			let rust = new RustPlugin(path);
			const envelopes = new Set<number>();
			const recording = createTauriConnector({
				createChannel: rust.createChannel,
				invoke: (command, args, options) => {
					if (command.endsWith("|send"))
						envelopes.add((args as Uint8Array)[0]!);
					return rust.invoke(command, args, options);
				},
			});
			const { workspace, note } = createWorkspace("rust-first", recording);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			await edit(note, workspace);
			expect([...envelopes].sort()).toEqual([1, 2]);
			expect(await rust.stop()).toBe(0);

			const db = new Database(path);
			const store = new SqlitePatchStore(db);
			// Rust expanded grouped uploads into the exact rows of the TypeScript log.
			expect(byKey(await store.missing(note.id, []))).toEqual(
				byKey(getPulseMeta(note).log.missing([])),
			);
			expect(await store.vector(note.id)).toEqual(
				getPulseMeta(note).log.vector,
			);
			const loaded = await loadWorkspace(
				"rust-first",
				createTauriConnector(createStorePlugin(store)),
			);
			expect(snapshotPulse(loaded.note)).toEqual(snapshotPulse(note));
			loaded.note.title = "Extended by TypeScript";
			await flush(loaded.note);
			destroyPulse(loaded.note);
			destroyPulse(loaded.workspace);
			db.close();

			rust = new RustPlugin(path);
			const again = await loadWorkspace(
				"rust-first",
				createTauriConnector(rust),
			);
			expect(again.note.title).toBe("Extended by TypeScript");
			expect(again.note.body.toString()).toBe(note.body.toString());
			destroyPulse(again.note);
			destroyPulse(again.workspace);
			destroyPulse(note);
			destroyPulse(workspace);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);

	test(
		"a file written by SqlitePatchStore is read and extended by Rust",
		async () => {
			const path = join(directory, "ts-first.sqlite");
			const db = new Database(path);
			const store = new SqlitePatchStore(db);
			const { workspace, note } = createWorkspace(
				"ts-first",
				createTauriConnector(createStorePlugin(store)),
			);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			await edit(note, workspace);
			const expected = snapshotPulse(note);
			const written = getPulseMeta(note).log.missing([]).length;
			const noteId = note.id;
			destroyPulse(note);
			destroyPulse(workspace);
			db.close();

			const rust = new RustPlugin(path);
			const loaded = await loadWorkspace(
				"ts-first",
				createTauriConnector(rust),
			);
			expect(snapshotPulse(loaded.note)).toEqual(expected);
			loaded.note.tags.push("from Rust");
			await flush(loaded.note);
			destroyPulse(loaded.note);
			destroyPulse(loaded.workspace);
			expect(await rust.stop()).toBe(0);

			const reopened = new SqlitePatchStore(new Database(path));
			const rows = await reopened.missing(noteId, []);
			const final = await loadWorkspace(
				"ts-first",
				createTauriConnector(createStorePlugin(reopened)),
			);
			expect([...final.note.tags]).toEqual(["a", "b", "c", "from Rust"]);
			expect(rows.length).toBeGreaterThan(written);
			destroyPulse(final.note);
			destroyPulse(final.workspace);
		},
		timeout,
	);

	test(
		"a file compacted by SqlitePatchStore is read and extended by Rust",
		async () => {
			const path = join(directory, "compacted.sqlite");
			const db = new Database(path);
			const store = new SqlitePatchStore(db);
			const { workspace, note } = createWorkspace(
				"compacted",
				createTauriConnector(createStorePlugin(store)),
			);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			await edit(note, workspace);
			const expected = snapshotPulse(note);
			const log = byKey(getPulseMeta(note).log.missing([]));
			const noteId = note.id;
			// The note and the workspace each become one packed segment.
			expect(await store.compact({ minRows: 2 })).toMatchObject({
				segments: 2,
			});
			expect(byKey(await store.missing(noteId, []))).toEqual(log);
			destroyPulse(note);
			destroyPulse(workspace);
			db.close();

			// Rust serves the rows inside the packed segment.
			const rust = new RustPlugin(path);
			const loaded = await loadWorkspace(
				"compacted",
				createTauriConnector(rust),
			);
			expect(snapshotPulse(loaded.note)).toEqual(expected);
			expect(byKey(getPulseMeta(loaded.note).log.missing([]))).toEqual(log);
			loaded.note.tags.push("from Rust");
			// A fresh synchronization uploads every row again, the packed ones too.
			await flush(loaded.note);
			destroyPulse(loaded.note);
			destroyPulse(loaded.workspace);
			expect(await rust.stop()).toBe(0);

			const reopened = new Database(path);
			const rows = await new SqlitePatchStore(reopened).missing(noteId, []);
			// Rust's rows come from another actor: the packed ones are still all there.
			const packed = new Set(log.map((row) => `${row.sid} ${row.clock}`));
			expect(
				byKey(rows.filter((row) => packed.has(`${row.sid} ${row.clock}`))),
			).toEqual(log);
			expect(rows.length).toBeGreaterThan(log.length);
			expect(
				reopened
					.query(
						"SELECT packed, COUNT(*) AS count FROM pulsify_op_rows WHERE doc_id=? GROUP BY packed ORDER BY packed",
					)
					.all(noteId),
			).toEqual([
				{ packed: 0, count: rows.length - log.length },
				{ packed: 1, count: 1 },
			]);
			reopened.close();
		},
		timeout,
	);

	test(
		"a field rewritten by two clients keeps one row per client, in a file that both stores write",
		async () => {
			const path = join(directory, "registers.sqlite");
			let rust = new RustPlugin(path);
			// Every frame the hub receives, in the order it serves them.
			const frames: Uint8Array[] = [];
			const recording: FakePlugin = {
				createChannel: rust.createChannel,
				invoke: (command, args, options) => {
					if (command.endsWith("|send"))
						frames.push((args as Uint8Array).slice());
					return rust.invoke(command, args, options);
				},
			};
			const connector = createTauriConnector(recording);
			const { workspace, note } = createWorkspace("registers", connector);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			const other = await loadWorkspace("registers", connector);
			const pulses = [note, workspace, other.note, other.workspace];
			const converged = () =>
				eventually(() => {
					expect(other.note.title).toBe(note.title);
					expect(other.workspace.name).toBe(workspace.name);
					for (const pulse of pulses)
						expect(getPulseMeta(pulse).status).toBe("synced");
				});
			const rewrites = 300;
			for (let i = 0; i < rewrites; i++) {
				// Bursts of concurrent writes, then turns taken once both agree.
				(i % 2 ? note : other.note).title = `Title ${i}`;
				if (i % 3 === 0)
					(i % 2 ? other.workspace : workspace).name = `Team ${i}`;
				if (i % 5 === 0) note.tags.push(`tag ${i}`);
				if (i % 20 === 19) await converged();
				else await new Promise((resolve) => setTimeout(resolve, 0));
			}
			await flush(...pulses);
			await converged();
			expect(note.title).toMatch(/^Title 29[89]$/);
			const expected = snapshotPulse(note);
			const noteId = note.id;

			// A client that starts now loads the same documents, from few rows.
			const fresh = await loadWorkspace(
				"registers",
				createTauriConnector(rust),
			);
			expect(snapshotPulse(fresh.workspace)).toEqual(snapshotPulse(workspace));
			expect(snapshotPulse(fresh.note)).toEqual(expected);
			// The creation, the tags that were pushed, each client's last title,
			// and a gap row for each client whose first writes were replaced.
			const history = 1 + rewrites / 5;
			const served = await downloadRows(rust, noteId);
			expect(heldRows(served).length).toBe(history + 2);
			expect(served.length).toBeLessThanOrEqual(history + 4);
			expect(
				heldRows(await downloadRows(rust, "registers")).length,
			).toBeLessThanOrEqual(6);
			for (const pulse of [fresh.note, fresh.workspace, ...pulses])
				destroyPulse(pulse);
			expect(await rust.stop()).toBe(0);

			// The file holds what was served, the values apart.
			const db = new Database(path);
			expect(rowCount(db, noteId)).toBe(heldRows(served).length);
			expect(expectValues(db)).toBeGreaterThanOrEqual(2);
			// SqlitePatchStore, given the same frames, writes the same file.
			const twin = new Database(":memory:");
			const reference = new SqlitePatchStore(twin);
			for (const frame of frames)
				await relayStoreMessage(reference, frame, { protocolVersion: 2 });
			expect(tables(db)).toEqual(tables(twin));
			twin.close();

			// SqlitePatchStore reads the values Rust wrote, and keeps them.
			const store = new SqlitePatchStore(db);
			const loaded = await loadWorkspace(
				"registers",
				createTauriConnector(createStorePlugin(store)),
			);
			expect(snapshotPulse(loaded.note)).toEqual(expected);
			for (let i = 0; i < 40; i++) {
				loaded.note.title = `TypeScript ${i}`;
				loaded.workspace.name = `TypeScript team ${i}`;
				await flush(loaded.note, loaded.workspace);
			}
			expectValues(db);
			// Its own writes replaced each other: one value for the new client.
			expect(rowCount(db, noteId)).toBe(heldRows(served).length + 1);
			destroyPulse(loaded.note);
			destroyPulse(loaded.workspace);
			db.close();

			// And Rust reads the values SqlitePatchStore wrote, and keeps them.
			rust = new RustPlugin(path);
			const again = await loadWorkspace(
				"registers",
				createTauriConnector(rust),
			);
			expect(again.note.title).toBe("TypeScript 39");
			expect(again.workspace.name).toBe("TypeScript team 39");
			expect([...again.note.tags]).toEqual(expected.tags);
			for (let i = 0; i < 40; i++) {
				again.note.title = `Rust ${i}`;
				await flush(again.note);
			}
			const last = await loadWorkspace("registers", createTauriConnector(rust));
			expect(last.note.title).toBe("Rust 39");
			for (const pulse of [
				last.note,
				last.workspace,
				again.note,
				again.workspace,
			])
				destroyPulse(pulse);
			expect(await rust.stop()).toBe(0);
			const reopened = new Database(path);
			expectValues(reopened);
			expect(rowCount(reopened, noteId)).toBe(heldRows(served).length + 2);
			reopened.close();
		},
		timeout,
	);

	test(
		"random histories leave the same file as SqlitePatchStore",
		async () => {
			const path = join(directory, "random.sqlite");
			const rust = new RustPlugin(path);
			const twin = new Database(":memory:");
			const reference = new SqlitePatchStore(twin);
			const outcomes = { stored: 0, refused: 0, replaced: 0, waiting: 0 };
			for (let seed = 1; seed <= 40; seed++) {
				let state = seed * 2654435761;
				const below = (limit: number) => {
					state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
					return Math.floor((state / 2 ** 32) * limit);
				};
				const chance = (percent: number) => below(100) < percent;
				const docId = `random/${seed}`;
				// For each actor, contiguous rows that build on the previous one and
				// sometimes on other actors, further than they will ever write.
				const lengths = Array.from(
					{ length: 2 + below(3) },
					() => 3 + below(9),
				);
				const history = lengths.map((length, actor) => {
					let clock = 1;
					return Array.from({ length }, () => {
						const sid = 65536 + actor,
							span = 1 + below(3);
						const dependencies: [number, number][] = [];
						lengths.forEach((other, i) => {
							if (i === actor) {
								if (clock > 1) dependencies.push([sid, clock]);
							} else if (chance(25))
								dependencies.push([65536 + i, 1 + below(other * 2)]);
						});
						const bytes = Array.from({ length: 1 + below(12) }, () =>
							below(256),
						);
						// Often a write to one of a few registers without history, at
						// a time unrelated to its place in the actor's history.
						const head = chance(45)
							? [3, 1 + below(40), 0, 1, 7 + below(2), 1, 110, 1, below(3)]
							: [];
						const row: StoredPatchRow = {
							docId,
							sid,
							clock,
							span,
							dependencies,
							operations: Uint8Array.from([...head, ...bytes]),
						};
						clock += span;
						return row;
					});
				});
				const uploader = await openUploader(rust, docId);
				const next = lengths.map(() => 0);
				for (let step = 0; step < 70; step++) {
					const batch: StoredPatchRow[] = [];
					for (let n = 1 + below(5); n > 0; n--) {
						const actor = below(history.length),
							rows = history[actor]!;
						let row =
							chance(55) && next[actor]! < rows.length
								? rows[next[actor]!++]!
								: rows[below(rows.length)]!;
						if (chance(15)) {
							// What contradicts the history, and what a peer that replaced
							// writes would send: a longer span, a gap row.
							const mutation = below(5);
							if (mutation === 0)
								row = {
									...row,
									operations: Uint8Array.of(...row.operations, 1),
								};
							else if (mutation === 1)
								row = {
									...row,
									dependencies: row.dependencies.filter(
										([sid]) => sid !== row.sid,
									),
								};
							else if (mutation === 2)
								row = { ...row, operations: Uint8Array.of(3, 1, 0, 0) };
							else if (mutation === 3) row = { ...row, clock: row.clock + 1 };
							else row = { ...row, span: row.span + 1 + below(5) };
						}
						batch.push(row);
					}
					const { frame, reply } = await uploader.upload(batch);
					const expected = decodeMessage(
						(await relayStoreMessage(reference, frame)).responses[0]!,
					);
					expect(reply).toEqual(expected);
					if (reply.kind === 5) outcomes.stored++;
					else outcomes.refused++;
				}
				await uploader.close();
				const served = await reference.missing(docId, []);
				expect(byKey(await downloadRows(rust, docId))).toEqual(byKey(served));
				// Writes that became ready and are no longer held were replaced.
				const vector = new Map(await reference.vector(docId));
				const held = new Set(
					heldRows(served).map((row) => `${row.sid} ${row.clock}`),
				);
				for (const row of history.flat())
					if (
						row.clock < (vector.get(row.sid) ?? 1) &&
						!held.has(`${row.sid} ${row.clock}`)
					)
						outcomes.replaced++;
			}
			expect(await rust.stop()).toBe(0);
			const written = new Database(path);
			expect(tables(written)).toEqual(tables(twin));
			expect(expectValues(written)).toBeGreaterThan(20);
			for (const row of tables(written).rows as { ready: number }[])
				if (!row.ready) outcomes.waiting++;
			// The histories reach every outcome, not only the easy one.
			expect(outcomes.stored).toBeGreaterThan(1500);
			expect(outcomes.refused).toBeGreaterThan(300);
			expect(outcomes.replaced).toBeGreaterThan(20);
			expect(outcomes.waiting).toBeGreaterThan(20);
			written.close();
			twin.close();
		},
		timeout,
	);

	test(
		"rows stored through one session reach the document's other sessions",
		async () => {
			const rust = new RustPlugin(join(directory, "live.sqlite"));
			const connector = createTauriConnector(rust);
			const { workspace, note } = createWorkspace("live", connector);
			await Promise.all([workspace, note].map((p) => connectPulse(p).synced));
			const other = await loadWorkspace("live", connector);
			other.note.body.insert(0, "Shared: ");
			other.note.title = "Live";
			await eventually(() => {
				expect(note.title).toBe("Live");
				expect(note.body.toString()).toBe("Shared: Draft");
			});
			note.tags.push("back");
			await eventually(() =>
				expect([...other.note.tags]).toEqual(["a", "back"]),
			);
			for (const pulse of [other.note, other.workspace, note, workspace])
				destroyPulse(pulse);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);
	test(
		"connected pulses reconnect on their own when the Rust process restarts",
		async () => {
			const path = join(directory, "restart.sqlite");
			let current: RustPlugin | undefined = new RustPlugin(path);
			// The webview outlives the Rust side: commands fail while it is down.
			const plugin = {
				createChannel: current.createChannel,
				invoke: ((...args: Parameters<RustPlugin["invoke"]>) =>
					current
						? current.invoke(...args)
						: Promise.reject({
								code: "CONNECTION_FAILED",
								message: "Rust side unavailable",
							})) as RustPlugin["invoke"],
			};
			const scope = createPulseScope();
			const note = createPulse(
				Note,
				{ title: "Before", body: "Draft", tags: [], stats: { views: 0 } },
				{
					scope,
					connectors: [createTauriConnector(plugin)],
					reconnect: {
						initialDelayMs: 5,
						maxDelayMs: 20,
						factor: 2,
						jitter: 0,
					},
				},
			);
			await connectPulse(note).synced;
			const stopping = current;
			current = undefined;
			await stopping.stop();
			note.title = "Written while Rust was down";
			note.body.insert(0, "Offline: ");
			await eventually(() => expect(getPulseMeta(note).status).toBe("offline"));
			current = new RustPlugin(path);
			await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
			const expected = snapshotPulse(note);
			const id = note.id;
			destroyPulse(note);
			const reloaded = await loadPulse(Note, id, {
				scope: createPulseScope(),
				connectors: [createTauriConnector(current)],
				waitFor: "all",
			});
			expect(snapshotPulse(reloaded)).toEqual(expected);
			destroyPulse(reloaded);
			expect(await current.stop()).toBe(0);
		},
		timeout,
	);
});
