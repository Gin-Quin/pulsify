import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePatchStore } from "../source/storage.js";

const row = (docId: string) => ({
	docId,
	sid: 70001,
	clock: 1,
	span: 1,
	dependencies: [],
	operations: Uint8Array.of(99),
});

test("SQLite markers and recovery data survive reopen, and stale vector caches cannot bypass them", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pulsify-deletion-")),
		path = join(directory, "db");
	let db = new Database(path);
	try {
		const a = new SqlitePatchStore(db),
			cached = new SqlitePatchStore(db, { vectorCacheSize: 128 });
		await a.append([row("r/a")]);
		await cached.vector("r/a");
		await a.deleteDocuments("r/a", { preserveRows: true });
		await expect(cached.vector("r/a")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(cached.append([row("r/a/offline")])).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await a.compact();
		db.close();
		db = new Database(path);
		const reopened = new SqlitePatchStore(db);
		expect(await reopened.isDeleted("r/a/offline")).toBe(true);
		expect(await reopened.recoverRows("r/a")).toEqual([row("r/a")]);
		expect(await reopened.documents("r")).toEqual([]);
	} finally {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a durable marker hides leftover rows if payload cleanup was interrupted", async () => {
	const db = new Database(":memory:");
	try {
		const store = new SqlitePatchStore(db, { vectorCacheSize: 128 });
		await store.append([row("r/a")]);
		await store.vector("r/a");
		// Model a committed tombstone whose payload sweep has not run yet.
		db.query("INSERT INTO pulsify_tombstones(prefix) VALUES(?)").run("r/a");
		await expect(store.vector("r/a")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(store.append([row("r/a/new")])).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await store.documents("r")).toEqual([]);
		expect(await store.deleteDocuments("r/a")).toBe(1);
		expect(await store.recoverRows("r/a")).toEqual([]);
	} finally {
		db.close();
	}
});

test("SQLite subtree pages stay fast with ten thousand permanent tombstones", async () => {
	const db = new Database(":memory:");
	try {
		const store = new SqlitePatchStore(db);
		db.transaction(() => {
			const marker = db.query(
				"INSERT INTO pulsify_tombstones(prefix) VALUES(?)",
			);
			const clock = db.query(
				"INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,2)",
			);
			for (let i = 0; i < 10000; i++) marker.run(`r/dead/${i}`);
			// Retained history must still be filtered and pages filled past it.
			for (let i = 0; i < 100; i++) clock.run(`r/dead/${i}/child`, 70001);
			for (let i = 0; i < 2000; i++)
				for (const sid of [70001, 70002])
					clock.run(`r/live/${String(i).padStart(4, "0")}`, sid);
		})();
		const start = performance.now(),
			found: string[] = [];
		for (;;) {
			const page = await store.documents("r", found.at(-1) ?? "", 128);
			if (!page.length) break;
			found.push(...page);
		}
		expect(performance.now() - start).toBeLessThan(2000);
		expect(found).toEqual(
			Array.from(
				{ length: 2000 },
				(_, i) => `r/live/${String(i).padStart(4, "0")}`,
			),
		);
	} finally {
		db.close();
	}
});

test("failed SQLite recovery still persists deletion and preserves original rows", async () => {
	for (const recovery of [
		[{ ...row("r/a"), operations: Uint8Array.of(98) }],
		[row("outside")],
	]) {
		const db = new Database(":memory:");
		try {
			const store = new SqlitePatchStore(db);
			await store.append([row("r/a")]);
			await expect(store.markDeleted("r/a", recovery)).rejects.toBeDefined();
			expect(await store.isDeleted("r/a/offline")).toBe(true);
			expect(await store.recoverRows("r/a")).toEqual([row("r/a")]);
			await expect(store.append([row("r/a/new")])).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		} finally {
			db.close();
		}
	}
});
