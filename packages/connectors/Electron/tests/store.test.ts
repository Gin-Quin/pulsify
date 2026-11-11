import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import Database from "better-sqlite3";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	destroyPulse,
	loadPulse,
	type Connector,
} from "pulsify-core";
import { PulseError, relayStoreMessage } from "pulsify-core/protocol";
import { SqlitePatchStore, type StoredPatchRow } from "pulsify-core/storage";
import { betterSqliteConnection } from "../source/main";
import { createApp, Note, persisted, temporaryFile } from "./helpers";

/** Two operation rows from one actor, written through the Electron IPC store. */
async function history(database: Database.Database) {
	const app = createApp(database);
	const { connector } = app.openWindow();
	const scope = createPulseScope();
	const note = createPulse(
		Note,
		{ title: "Rows", body: "Hi", tags: [], meta: { count: 0 } },
		{ scope, connectors: [connector] },
	);
	await connectPulse(note).synced;
	note.body.insert(2, " there");
	note.tags.push("x");
	await persisted(note);
	const docId = note.id;
	destroyPulse(note);
	await app.server.close();
	const store = new SqlitePatchStore(betterSqliteConnection(database));
	const rows = await store.missing(docId, []);
	expect(rows.length).toBeGreaterThanOrEqual(2);
	return { docId, rows, vector: await store.vector(docId) };
}

function storeConnector(store: SqlitePatchStore): Connector {
	return {
		kind: "local",
		async open({ docId, onMessage }) {
			return {
				protocolVersion: 2,
				close() {},
				async send(bytes) {
					const result = await relayStoreMessage(store, bytes, {
						docId,
						protocolVersion: 2,
					});
					for (const frame of result.responses)
						queueMicrotask(() => onMessage(frame));
				},
			};
		},
	};
}

describe("better-sqlite3 store", () => {
	test("rows round-trip as Uint8Array; vector and missing queries", async () => {
		const { docId, rows, vector } = await history(new Database(":memory:"));
		const store = new SqlitePatchStore(
			betterSqliteConnection(new Database(":memory:")),
		);
		expect(await store.vector(docId)).toEqual([]);
		expect(await store.missing(docId, [])).toEqual([]);

		const result = await store.append(rows);
		expect(result).toEqual({
			inserted: rows.length,
			ready: rows.length,
			pending: 0,
		});
		expect(await store.vector(docId)).toEqual(vector);
		const stored = await store.missing(docId, []);
		expect(stored).toEqual(rows);
		for (const row of stored)
			expect(Object.getPrototypeOf(row.operations)).toBe(Uint8Array.prototype);

		const first = rows[0]!;
		const after = await store.missing(docId, [
			[first.sid, first.clock + first.span],
		]);
		expect(after).toEqual(rows.slice(1));
		expect(await store.missing(docId, vector)).toEqual([]);
	});

	test("duplicates are idempotent; out-of-order rows wait for their dependencies", async () => {
		const { docId, rows, vector } = await history(new Database(":memory:"));
		const store = new SqlitePatchStore(
			betterSqliteConnection(new Database(":memory:")),
		);
		const [first, ...rest] = rows as [StoredPatchRow, ...StoredPatchRow[]];
		expect(await store.append(rest)).toEqual({
			inserted: rest.length,
			ready: 0,
			pending: rest.length,
		});
		expect(await store.vector(docId)).toEqual([]);
		expect(await store.missing(docId, [])).toEqual([]);
		expect(await store.append([first])).toEqual({
			inserted: 1,
			ready: rows.length,
			pending: 0,
		});
		expect(await store.vector(docId)).toEqual(vector);
		expect(await store.append(rows)).toEqual({
			inserted: 0,
			ready: 0,
			pending: 0,
		});
		expect(await store.missing(docId, [])).toEqual(rows);
	});

	test("a conflicting segment rolls back the whole batch", async () => {
		const { docId, rows } = await history(new Database(":memory:"));
		const store = new SqlitePatchStore(
			betterSqliteConnection(new Database(":memory:")),
		);
		const [first, second] = rows as [StoredPatchRow, StoredPatchRow];
		await store.append([first]);
		const operations = first.operations.slice();
		operations[operations.length - 1]! ^= 0xff;
		const conflict = { ...first, operations };
		const failure = await store
			.append([second, conflict])
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PulseError);
		expect((failure as PulseError).code).toBe("CONFLICT");
		expect(await store.missing(docId, [])).toEqual([first]);
		expect(await store.append([second])).toMatchObject({ inserted: 1 });
	});

	test("files written in Electron are readable by bun:sqlite, and back", async () => {
		const file = temporaryFile();
		const electron = new Database(file);
		electron.pragma("journal_mode = WAL");
		const { docId, rows, vector } = await history(electron);
		electron.close();

		const bun = new BunDatabase(file);
		const store = new SqlitePatchStore(bun);
		expect(await store.vector(docId)).toEqual(vector);
		expect(await store.missing(docId, [])).toEqual(rows);
		const scope = createPulseScope();
		const note = await loadPulse(Note, docId, {
			scope,
			connectors: [storeConnector(store)],
			waitFor: "all",
		});
		expect(note.body.toString()).toBe("Hi there");
		note.title = "From Bun";
		await persisted(note);
		destroyPulse(note);
		bun.close();

		const app = createApp(file);
		const reopened = await loadPulse(Note, docId, {
			scope: createPulseScope(),
			connectors: [app.openWindow().connector],
			waitFor: "all",
		});
		expect(reopened.title).toBe("From Bun");
		expect([...reopened.tags]).toEqual(["x"]);
		destroyPulse(reopened);
		await app.server.close();
	});

	test("prepared statements are cached per connection", () => {
		const database = new Database(":memory:");
		let prepared = 0;
		const prepare = database.prepare.bind(database);
		const counting = Object.assign(Object.create(database), {
			prepare(sql: string) {
				prepared++;
				return prepare(sql);
			},
			exec: (sql: string) => database.exec(sql),
			transaction: <T>(work: () => T) => database.transaction(work),
		});
		const connection = betterSqliteConnection(counting);
		connection.query("SELECT 1 AS one").get();
		expect(connection.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
		expect(prepared).toBe(1);
	});
});
