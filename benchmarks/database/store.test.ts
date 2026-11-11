import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	destroyPulse,
	snapshotPulse,
} from "../../packages/pulse/source/index.js";
import { postgresRepository, sqliteRepository } from "./adapters/sql.js";
import { applyRows, fixture, receiver } from "./fixtures.js";
import { pack, unpack } from "./segments.js";
import { statistics } from "./report.js";
import { BenchmarkStore } from "./store.js";
import type { SegmentRepository } from "./types.js";

const backends = [
	"sqlite",
	...(process.env["PULSIFY_DATABASE_INTEGRATION"] ? ["postgres"] : []),
];
for (const name of backends) {
	describe(`${name} database benchmark contract`, () => {
		async function withStore(work: (store: BenchmarkStore) => Promise<void>) {
			const path = `/tmp/pulsify-db-test-${crypto.randomUUID()}.sqlite`;
			let repository: SegmentRepository;
			if (name === "sqlite") repository = sqliteRepository(path);
			else
				repository = await postgresRepository(
					process.env["PULSIFY_POSTGRES_URL"]!,
				);
			try {
				await work(new BenchmarkStore(repository));
			} finally {
				await repository.close();
				await rm(path, { force: true });
			}
		}
		test("real multi-actor history, partial vectors, lossless compaction and fresh/incremental replay", () =>
			withStore(async (store) => {
				const f = fixture("small");
				await store.append([...f.initial, ...f.patches.flat()]);
				const full = await store.read(f.docId),
					delta = await store.read(f.docId, f.remote);
				expect(await store.vector(f.docId)).toEqual(f.vector);
				expect(delta.rows.length).toBeLessThan(full.rows.length);
				await store.compact(f.docId);
				const compacted = await store.read(f.docId);
				expect(compacted.rows).toEqual(full.rows);
				expect(compacted.segments).toBeLessThan(full.segments);
				expect(compacted.payloadBytes).toBeLessThan(full.payloadBytes);
				expect((await store.read(f.docId, f.remote)).rows).toEqual(delta.rows);
				expect(await store.vector(f.docId)).toEqual(f.vector);
				expect((await store.read(f.docId, f.vector)).rows).toEqual([]);
				for (const incremental of [false, true]) {
					const peer = receiver(f.docId);
					try {
						if (incremental) applyRows(peer, f.prefix);
						applyRows(
							peer,
							incremental
								? (await store.read(f.docId, f.remote)).rows
								: compacted.rows,
						);
						expect(snapshotPulse(peer)).toEqual(f.expected);
					} finally {
						destroyPulse(peer);
					}
				}
			}));
		test("a vector inside a span includes that segment; omitted actors still return their history", () =>
			withStore(async (store) => {
				const f = fixture("small");
				await store.append([...f.initial, ...f.patches.flat()]);
				const first = {
					...f.initial[0]!,
					docId: `span-${crypto.randomUUID()}`,
					span: 5,
				};
				await store.append([first]);
				const inside = await store.read(first.docId, [
					[first.sid, first.clock + 1],
				]);
				expect(inside.rows).toContainEqual(first);
				const omitted = await store.read(f.docId, [[f.initial[0]!.sid, 2]]);
				expect(new Set(omitted.rows.map((row) => row.sid)).size).toBe(2);
			}));
		test("identical appends are idempotent; conflicts and gaps roll back atomically", () =>
			withStore(async (store) => {
				const f = fixture("small");
				await store.append(f.initial);
				await store.append(f.initial);
				expect((await store.read(f.docId)).rows).toEqual(f.initial);
				const before = await store.vector(f.docId);
				await expect(
					store.append([
						f.patches[0]![0]!,
						{ ...f.patches[1]![0]!, clock: 999999 },
					]),
				).rejects.toThrow("Gap");
				expect(await store.vector(f.docId)).toEqual(before);
				expect((await store.read(f.docId)).rows).toEqual(f.initial);
				await expect(
					store.append([
						{ ...f.initial[0]!, operations: new Uint8Array([42]) },
					]),
				).rejects.toThrow("Conflicting");
			}));
		test("a concurrent append survives compaction; a stale competing plan is rejected", () =>
			withStore(async (store) => {
				const f = fixture("small");
				await store.append([...f.initial, ...f.patches.slice(0, -1).flat()]);
				const plans = await store.planCompaction(f.docId);
				await store.append(f.patches.at(-1)!);
				for (const { sources, replacement } of plans) {
					expect(await store.replace(f.docId, sources, replacement)).toBe(true);
					expect(await store.replace(f.docId, sources, replacement)).toBe(
						false,
					);
				}
				expect(await store.vector(f.docId)).toEqual(f.vector);
				const peer = receiver(f.docId);
				try {
					applyRows(peer, (await store.read(f.docId)).rows);
					expect(snapshotPulse(peer)).toEqual(f.expected);
				} finally {
					destroyPulse(peer);
				}
			}));
		test("large binary values round-trip losslessly", () =>
			withStore(async (store) => {
				const row = {
					...fixture("small").initial[0]!,
					docId: `large-${crypto.randomUUID()}`,
					operations: new Uint8Array(180_000).fill(239),
				};
				await store.append([row]);
				expect((await store.read(row.docId)).rows).toEqual([row]);
			}));
	});
}
test("segment encoding rejects non-contiguous history and detects corruption", () => {
	const f = fixture("small");
	expect(() => pack([])).toThrow();
	expect(() => pack([f.initial[0]!, f.patches[0]![0]!])).toThrow("contiguous");
	const segment = pack(f.initial, true);
	segment.payload[0] = segment.payload[0]! ^ 1;
	expect(() => unpack(segment)).toThrow("Corrupt");
});
test("report uses arithmetic median and nearest-rank p95", () => {
	expect(statistics([4, 1, 3, 2])).toEqual({ medianMs: 2.5, p95Ms: 4 });
	expect(statistics([3, 1, 2])).toEqual({ medianMs: 2, p95Ms: 3 });
});
