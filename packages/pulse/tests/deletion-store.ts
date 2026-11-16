import { describe, expect, test } from "bun:test";
import {
	encodeMessage,
	decodeMessage,
	relayStoreMessage,
} from "../source/protocol.js";
import type { DocumentStore, StoredPatchRow } from "../source/storage.js";

export function deletionStoreConformance(
	name: string,
	create: () => Promise<DocumentStore>,
) {
	const row = (docId: string, clock = 1): StoredPatchRow => ({
		docId,
		sid: 70001,
		clock,
		span: 1,
		dependencies: clock === 1 ? [] : [[70001, clock]],
		operations: Uint8Array.of(99, clock),
	});
	describe(`${name}: permanent deletion`, () => {
		test("pages exactly the requested subtree from any cursor, including past retained tombstones", async () => {
			const store = await create();
			const ids = [
				"doc/a",
				"doc/a/",
				"doc/a//x",
				"doc/a/0",
				"doc/a/keep",
				"doc/a/z",
				"doc/a-/sibling",
				"doc/ab",
				"other",
			];
			for (const id of ids) await store.append([row(id)]);
			await store.deleteDocuments("doc/a/0", { preserveRows: true });
			for (const after of [
				"",
				"doc",
				"doc/a",
				"doc/a-",
				"doc/a/",
				"doc/a//x",
				"doc/a/y",
				"doc/a0",
				"zzz",
			]) {
				const expected = ids
					.filter(
						(id) =>
							(id === "doc/a" || id.startsWith("doc/a/")) &&
							id !== "doc/a/0" &&
							id > after,
					)
					.sort();
				const found: string[] = [];
				let cursor = after;
				for (;;) {
					const page = await store.documents("doc/a", cursor, 2);
					if (!page.length) break;
					found.push(...page);
					cursor = page.at(-1)!;
				}
				expect(found).toEqual(expected);
			}
		});
		test("blocks deleted and never-seen descendants, preserves siblings and parents", async () => {
			const store = await create();
			for (const id of [
				"root",
				"root/a",
				"root/a/b",
				"root/a0",
				"root/ab",
				"root/é",
			])
				await store.append([row(id)]);
			await store.vector("root/a/b"); // Prime a possible cache.
			await store.append([row("root/a/pending", 4)]);
			expect(await store.deleteDocuments("root/a")).toBe(3);
			expect(await store.deleteDocuments("root/a")).toBe(0);
			for (const id of [
				"root/a",
				"root/a/b",
				"root/a/pending",
				"root/a/never/seen",
			]) {
				expect(await store.isDeleted(id)).toBe(true);
				await expect(store.vector(id)).rejects.toMatchObject({
					code: "NOT_FOUND",
				});
				await expect(store.missing(id, [])).rejects.toMatchObject({
					code: "NOT_FOUND",
				});
				await expect(store.append([row(id)])).rejects.toMatchObject({
					code: "NOT_FOUND",
				});
				expect(await store.recoverRows(id)).toEqual([]);
			}
			expect(await store.documents("root")).toEqual([
				"root",
				"root/a0",
				"root/ab",
				"root/é",
			]);
			expect(await store.documents("root", "root/a0", 1)).toEqual(["root/ab"]);
			for (const id of ["root", "root/a0", "root/ab", "root/é"])
				await store.append([row(id, 2)]);
			expect(await store.vector("unknown")).toEqual([]);
			await store.deleteDocuments("root");
			expect(await store.isDeleted("root/offline-child")).toBe(true);
		});
		test("retains recoverable operations without allowing reads, writes or enumeration", async () => {
			const store = await create(),
				original = row("root/a");
			await store.append([original]);
			await store.deleteDocuments("root/a", { preserveRows: true });
			expect(await store.recoverRows("root/a")).toEqual([original]);
			expect(await store.documents("root")).toEqual([]);
			await expect(store.append([row("root/a", 2)])).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await store.deleteDocuments("root/a");
			expect(await store.recoverRows("root/a")).toEqual([]);
			expect(await store.isDeleted("root/a/b")).toBe(true);
		});
		test("connect and upload return a terminal error, never an empty sync or acknowledgement", async () => {
			const store = await create();
			await store.deleteDocuments("root/a");
			for (const message of [
				{ kind: 1 as const, docId: "root/a/new", requestId: 1, vv: [] },
				{
					kind: 3 as const,
					docId: "root/a/new",
					requestId: 2,
					vv: [],
					rows: [row("root/a/new")],
				},
			]) {
				const result = await relayStoreMessage(store, encodeMessage(message));
				expect(result.broadcast).toBeUndefined();
				expect(result.responses.map(decodeMessage)).toMatchObject([
					{ kind: 6, code: "NOT_FOUND" },
				]);
			}
		});
	});
}
