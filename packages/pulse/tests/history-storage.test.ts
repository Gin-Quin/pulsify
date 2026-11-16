import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { object } from "@gin-quin/codec";
import {
	counter,
	createPulse,
	createPulseScope,
	definePulse,
	getPulseMeta,
	snapshotPulse,
	versioned,
	type Pulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	GAP_OPERATIONS,
	isGap,
	lastRegisterOf,
	PostgresPatchStore,
	SQLITE_PATCH_SCHEMA,
	SqlitePatchStore,
} from "../source/storage.js";
import { lastValueStoreConformance } from "./history-store.js";

lastValueStoreConformance(
	"SQLite",
	async () => new SqlitePatchStore(new Database(":memory:")),
);
lastValueStoreConformance(
	"SQLite with a vector cache",
	async () =>
		new SqlitePatchStore(new Database(":memory:"), { vectorCacheSize: 8 }),
);

// Set PULSIFY_TEST_POSTGRES to a database URL to run the same against PostgreSQL.
const postgres = process.env["PULSIFY_TEST_POSTGRES"];
if (postgres) {
	const sql = new SQL(postgres);
	const store = new PostgresPatchStore((query, parameters) =>
		sql.unsafe(query, parameters as never[]),
	);
	const ready = store.initialize();
	lastValueStoreConformance("PostgreSQL", async () => {
		await ready;
		return store;
	});
}

describe("SQLite row changes per write", () => {
	const Counters = definePulse(
		"StoredCounters",
		object({
			title: "string",
			log: versioned("string"),
			a: counter(),
			b: counter(),
			c: counter(),
			d: counter(),
			e: counter(),
			f: counter(),
		}),
	).materialize();
	type Counters = Pulse<any> & {
		title: string;
		log: string;
		[name: string]: any;
	};
	const names = ["a", "b", "c", "d", "e", "f"] as const;
	const options = (sessionId: number) => ({
		...defaultPulseOptions,
		sessionId,
		scope: createPulseScope(),
	});
	function setup() {
		const db = new Database(":memory:");
		const store = new SqlitePatchStore(db);
		const changes = () =>
			(db.query("SELECT total_changes() AS n").get() as { n: number }).n;
		/** Row changes made by uploading what the store lacks. */
		const push = async (pulse: Pulse<any>) => {
			const { log, id } = getPulseMeta(pulse);
			const rows = log.missing(await store.vector(id));
			const start = changes();
			await store.append(rows);
			return changes() - start;
		};
		const pull = async (pulse: Pulse<any>) => {
			const { log, id } = getPulseMeta(pulse);
			getPulseMeta(pulse).applyRows(await store.missing(id, log.vector));
		};
		return { db, store, push, pull };
	}
	const create = (sessionId = 65536) =>
		createPulse(
			Counters,
			{
				id: crypto.randomUUID(),
				title: "",
				log: "",
				a: 0,
				b: 0,
				c: 0,
				d: 0,
				e: 0,
				f: 0,
			},
			options(sessionId),
		) as Counters;

	test("one actor rewriting one field", async () => {
		const { push } = setup(),
			pulse = create();
		await push(pulse);
		for (let i = 0; i < 20; i++) {
			pulse.title = `title ${i}`;
			expect(await push(pulse)).toBe(2);
		}
	});
	test("one actor rotating over six counters", async () => {
		const { push } = setup(),
			pulse = create();
		await push(pulse);
		for (let i = 0; i < 24; i++) {
			pulse[names[i % 6]!].increment();
			expect(await push(pulse)).toBe(2);
		}
	});
	test("two actors alternating on one field", async () => {
		const { store, push, pull } = setup(),
			a = create();
		await push(a);
		const b = createRuntime(Counters, a.id, options(65537)) as Counters;
		await pull(b);
		for (let i = 0; i < 20; i++) {
			const writer = i % 2 ? a : b;
			await pull(writer);
			writer.title = `turn ${i}`;
			expect(await push(writer)).toBe(2);
		}
		expect(await store.vector(a.id)).toEqual(getPulseMeta(a).log.vector);
	});
	test("six counters uploaded together", async () => {
		const { push } = setup(),
			pulse = create();
		await push(pulse);
		for (let round = 0; round < 5; round++) {
			for (const name of names) pulse[name].increment();
			expect(await push(pulse)).toBe(7);
		}
	});
	test("a history row", async () => {
		const { push } = setup(),
			pulse = create();
		await push(pulse);
		for (let i = 0; i < 20; i++) {
			pulse.log = `entry ${i}`;
			expect(await push(pulse)).toBe(2);
		}
	});
});

test("SQLite opens a database that indexed registers and stored gap rows", async () => {
	const Note = definePulse(
		"StoredUpgrade",
		object({ title: "string", log: versioned("string"), likes: counter() }),
	).materialize();
	type Note = Pulse<any> & {
		title: string;
		log: string;
		likes: { increment(): void };
	};
	const options = (sessionId: number) => ({
		...defaultPulseOptions,
		sessionId,
		scope: createPulseScope(),
	});
	const a = createPulse(
		Note,
		{ id: crypto.randomUUID(), title: "", log: "", likes: 0 },
		options(65536),
	) as Note;
	const b = createRuntime(Note, a.id, options(65537)) as Note;
	const sync = (from: Pulse<any>, to: Pulse<any>) =>
		getPulseMeta(to).applyRows(
			getPulseMeta(from).log.missing(getPulseMeta(to).log.vector),
		);
	sync(a, b);
	for (let i = 0; i < 10; i++) {
		a.title = `a ${i}`;
		a.log = `log ${i}`;
		a.likes.increment();
		b.title = `b ${i}`;
		b.likes.increment();
	}
	sync(a, b);
	sync(b, a);
	// What the journal holds is what that layout stored: one row per
	// register, spans grown over replaced writes, and gap rows.
	const old = getPulseMeta(a).log.missing([]);
	expect(old.some((row) => isGap(row.operations))).toBe(true);
	expect(old.some((row) => row.span > 1 && !isGap(row.operations))).toBe(true);
	const db = new Database(":memory:");
	db.exec(SQLITE_PATCH_SCHEMA);
	db.exec(`DROP TABLE pulsify_values;
CREATE TABLE pulsify_registers (
 doc_id TEXT NOT NULL, register BLOB NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 lamport INTEGER NOT NULL,
 PRIMARY KEY(doc_id, register)
) WITHOUT ROWID;`);
	for (const row of old) {
		db.query(
			"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES(?,?,?,?,?,?,1)",
		).run(
			a.id,
			row.sid,
			row.clock,
			row.span,
			JSON.stringify(row.dependencies),
			row.operations,
		);
		const last = lastRegisterOf(row.operations);
		if (last)
			db.query("INSERT INTO pulsify_registers VALUES(?,?,?,?,?)").run(
				a.id,
				last.register,
				row.sid,
				row.clock,
				last.lamport,
			);
	}
	for (const [sid, clock] of getPulseMeta(a).log.vector)
		db.query("INSERT INTO pulsify_doc_clocks VALUES(?,?,?)").run(
			a.id,
			sid,
			clock,
		);
	// A peer that knew the document before the upgrade.
	const c = createRuntime(Note, a.id, options(65538)) as Note;
	getPulseMeta(c).applyRows(old);

	const store = new SqlitePatchStore(db);
	const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
	expect(
		count(
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='pulsify_registers'",
		),
	).toBe(0);
	expect(count("SELECT COUNT(*) AS n FROM pulsify_values")).toBe(
		old.filter((row) => lastRegisterOf(row.operations)).length,
	);
	expect(
		count(
			"SELECT COUNT(*) AS n FROM pulsify_op_rows WHERE operations=X'03010000'",
		),
	).toBe(0);
	const vector = await store.vector(a.id);
	expect(vector).toEqual(getPulseMeta(a).log.vector);
	/** Served rows cover each actor without holes, from `since` to the frontier. */
	const assertServed = async (since: Map<number, number>) => {
		const next = new Map<number, number>();
		for (const row of await store.missing(a.id, [...since])) {
			const from = Math.max(since.get(row.sid) ?? 0, 1);
			const at = next.get(row.sid);
			if (at === undefined) {
				expect(row.clock).toBeLessThanOrEqual(from);
				expect(row.clock + row.span).toBeGreaterThan(from);
			} else expect(row.clock).toBe(at);
			next.set(row.sid, row.clock + row.span);
		}
		for (const [sid, clock] of vector)
			if (clock > (since.get(sid) ?? 0)) expect(next.get(sid)).toBe(clock);
	};
	await assertServed(new Map());
	for (const [sid, clock] of vector)
		for (let since = 1; since <= clock; since++)
			await assertServed(new Map([[sid, since]]));
	const fresh = createRuntime(Note, a.id, options(65539)) as Note;
	getPulseMeta(fresh).applyRows(await store.missing(a.id, []));
	expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));

	// It keeps working: new writes, a peer from before, and compaction.
	for (let i = 0; i < 5; i++) {
		a.title = `after ${i}`;
		a.log = `after ${i}`;
		await store.append(getPulseMeta(a).log.missing(await store.vector(a.id)));
	}
	getPulseMeta(c).applyRows(
		await store.missing(a.id, getPulseMeta(c).log.vector),
	);
	expect(snapshotPulse(c)).toEqual(snapshotPulse(a));
	await store.compact({ minRows: 2 });
	const late = createRuntime(Note, a.id, options(65540)) as Note;
	getPulseMeta(late).applyRows(await store.missing(a.id, []));
	expect(snapshotPulse(late)).toEqual(snapshotPulse(a));
	expect(getPulseMeta(late).log.vector).toEqual(await store.vector(a.id));
	// Opened again, nothing is left to move.
	new SqlitePatchStore(db);
	expect(await store.missing(a.id, [])).toEqual(
		await new SqlitePatchStore(db).missing(a.id, []),
	);
});

if (postgres)
	describe("PostgreSQL fields without history", () => {
		const sql = new SQL(postgres);
		test("pulsify_register reads what lastRegisterOf reads", async () => {
			await new PostgresPatchStore((query, parameters) =>
				sql.unsafe(query, parameters as never[]),
			).initialize();
			let state = 7;
			const below = (limit: number) => {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				return state % limit;
			};
			const payloads: Uint8Array[] = [GAP_OPERATIONS, Uint8Array.of(3)];
			for (let i = 0; i < 1500; i++) {
				// Heads that are mostly valid, with lengths and varuints that
				// sometimes reach past the end.
				const head = [3, 1 + below(300), below(3), 1, 7 + below(2), below(4)];
				const bytes = Array.from({ length: below(12) }, () =>
					below(5) ? below(8) : below(256),
				);
				const payload = Uint8Array.from([...head, ...bytes]);
				if (!below(4)) payload[below(payload.length)] = below(256);
				payloads.push(payload);
			}
			const rows = (await sql.unsafe(
				"SELECT pulsify_register(p) AS register FROM unnest($1::bytea[]) WITH ORDINALITY AS t(p,n) ORDER BY n",
				[payloads] as never[],
			)) as { register: Uint8Array | null }[];
			let found = 0;
			payloads.forEach((payload, i) => {
				const expected = lastRegisterOf(payload)?.register ?? null;
				const register = rows[i]!.register;
				expect(register && [...register]).toEqual(expected && [...expected]);
				if (expected) found++;
			});
			expect(found).toBeGreaterThan(150);
		});

		test("a database that indexed registers is migrated on initialize", async () => {
			const name = `pulsify_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
			await sql.unsafe(`CREATE DATABASE ${name}`);
			const url = new URL(postgres);
			url.pathname = `/${name}`;
			const db = new SQL(url.toString());
			try {
				const Note = definePulse(
					"PostgresUpgrade",
					object({
						title: "string",
						log: versioned("string"),
						likes: counter(),
					}),
				).materialize();
				type Note = Pulse<any> & {
					title: string;
					log: string;
					likes: { increment(): void };
				};
				const options = (sessionId: number) => ({
					...defaultPulseOptions,
					sessionId,
					scope: createPulseScope(),
				});
				const a = createPulse(
					Note,
					{ id: crypto.randomUUID(), title: "", log: "", likes: 0 },
					options(65536),
				) as Note;
				const b = createRuntime(Note, a.id, options(65537)) as Note;
				const sync = (from: Pulse<any>, to: Pulse<any>) =>
					getPulseMeta(to).applyRows(
						getPulseMeta(from).log.missing(getPulseMeta(to).log.vector),
					);
				sync(a, b);
				for (let i = 0; i < 10; i++) {
					a.title = `a ${i}`;
					a.log = `log ${i}`;
					a.likes.increment();
					b.title = `b ${i}`;
					b.likes.increment();
				}
				sync(a, b);
				sync(b, a);
				const old = getPulseMeta(a).log.missing([]);
				expect(old.some((row) => isGap(row.operations))).toBe(true);
				// The tables of that layout: a register and a Lamport time per row.
				await db.unsafe(`
CREATE TABLE pulsify_op_rows (
 doc_id text NOT NULL, sid bigint NOT NULL, time_start bigint NOT NULL, span bigint NOT NULL,
 time_end bigint GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies jsonb NOT NULL, operations bytea NOT NULL, ready boolean NOT NULL DEFAULT false,
 register bytea, lamport bigint, PRIMARY KEY(doc_id,sid,time_start));
CREATE INDEX pulsify_rows_register ON pulsify_op_rows(doc_id,register) WHERE register IS NOT NULL;
CREATE TABLE pulsify_doc_clocks (doc_id text NOT NULL, sid bigint NOT NULL, clock bigint NOT NULL, PRIMARY KEY(doc_id,sid));
CREATE VIEW pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE NOT ready;`);
				for (const row of old) {
					const last = lastRegisterOf(row.operations);
					await db.unsafe(
						"INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready,register,lamport) VALUES($1,$2,$3,$4,$5::text::jsonb,$6,true,$7,$8)",
						[
							a.id,
							row.sid,
							row.clock,
							row.span,
							JSON.stringify(row.dependencies),
							row.operations,
							last?.register ?? null,
							last?.lamport ?? null,
						] as never[],
					);
				}
				for (const [sid, clock] of getPulseMeta(a).log.vector)
					await db.unsafe("INSERT INTO pulsify_doc_clocks VALUES($1,$2,$3)", [
						a.id,
						sid,
						clock,
					] as never[]);

				const store = new PostgresPatchStore((query, parameters) =>
					db.unsafe(query, parameters as never[]),
				);
				await store.initialize();
				await store.initialize();
				const count = async (query: string) =>
					Number(((await db.unsafe(query)) as { n: unknown }[])[0]!.n);
				expect(
					await count(
						"SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name='pulsify_op_rows' AND column_name IN ('register','lamport')",
					),
				).toBe(0);
				expect(await count("SELECT COUNT(*) AS n FROM pulsify_values")).toBe(
					old.filter((row) => lastRegisterOf(row.operations)).length,
				);
				expect(
					await count(
						"SELECT COUNT(*) AS n FROM pulsify_op_rows WHERE operations='\\x03010000'::bytea",
					),
				).toBe(0);
				const fresh = createRuntime(Note, a.id, options(65539)) as Note;
				getPulseMeta(fresh).applyRows(await store.missing(a.id, []));
				expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
				for (let i = 0; i < 5; i++) {
					a.title = `after ${i}`;
					a.log = `after ${i}`;
					await store.append(
						getPulseMeta(a).log.missing(await store.vector(a.id)),
					);
				}
				getPulseMeta(fresh).applyRows(
					await store.missing(a.id, getPulseMeta(fresh).log.vector),
				);
				expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
			} finally {
				await db.close();
				await sql.unsafe(`DROP DATABASE ${name}`);
			}
		});
	});
