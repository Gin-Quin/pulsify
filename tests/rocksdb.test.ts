import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { array, object } from "@gin-quin/codec";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	richText,
	snapshotPulse,
	versioned,
	type Connector,
} from "../packages/pulse/source/index";
import { isGap, type StoredPatchRow } from "../packages/pulse/source/storage";
import { createTauriConnector } from "../packages/connectors/Tauri/source/index";
import {
	downloadRows,
	RustPlugin,
} from "../packages/connectors/Tauri/tests/plugins";

// The pulsify-rocksdb harness speaks the same JSON lines as the pulsify-sqlite
// one: real documents go through the Tauri connector to the Rust hub.
const manifest = new URL(
	"../crates/pulsify-rocksdb/Cargo.toml",
	import.meta.url,
).pathname;
const binary = new URL(
	"../crates/pulsify-rocksdb/target/debug/pulsify-rocksdb",
	import.meta.url,
).pathname;
const cargo = Bun.which("cargo");
if (!cargo)
	console.warn(
		"Skipping the pulsify-rocksdb interoperability tests: cargo is not installed.",
	);
else {
	const build = Bun.spawnSync([
		cargo,
		"build",
		"--locked",
		"--quiet",
		"--manifest-path",
		manifest,
	]);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}
const directory = mkdtempSync(join(tmpdir(), "pulsify-rocksdb-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const timeout = 60_000;

const Note = definePulse(
	"RocksNote",
	object({
		title: "string",
		body: richText(),
		tags: array("string"),
		// Every write is kept: consecutive ones travel as one grouped run.
		stats: versioned(object({ views: "float64" })),
	}),
).materialize();
const createNote = (id: string, connector: Connector) =>
	createPulse(
		Note,
		{ id, title: "Plan", body: "Draft", tags: ["a"], stats: { views: 0 } },
		{ scope: createPulseScope(), connectors: [connector] },
	);
const loadNote = (id: string, connector: Connector) =>
	loadPulse(Note, id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
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

describe.skipIf(!cargo)("Rust RocksDB hub", () => {
	test(
		"documents survive a restart",
		async () => {
			const path = join(directory, "restart");
			let rust = new RustPlugin(path, binary);
			const note = createNote("restart", createTauriConnector(rust));
			await connectPulse(note).synced;
			note.body.insert(5, " 🌍 written in Rust's store");
			note.tags.push("b", "c");
			// A fresh synchronization uploads every local row.
			disconnectPulse(note);
			await connectPulse(note).synced;
			// Consecutive writes of one scalar travel as one grouped (envelope 2) run.
			for (let i = 1; i <= 100; i++) note.stats.views = i;
			disconnectPulse(note);
			await connectPulse(note).synced;
			const expected = snapshotPulse(note);
			destroyPulse(note);
			expect(await rust.stop()).toBe(0);

			rust = new RustPlugin(path, binary);
			const loaded = await loadNote("restart", createTauriConnector(rust));
			expect(snapshotPulse(loaded)).toEqual(expected);
			expect(loaded.body.toString()).toBe("Draft 🌍 written in Rust's store");
			expect([...loaded.tags]).toEqual(["a", "b", "c"]);
			expect(loaded.stats.views).toBe(100);
			destroyPulse(loaded);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);

	test(
		"a field rewritten by two clients keeps one row per client",
		async () => {
			const path = join(directory, "registers");
			let rust = new RustPlugin(path, binary);
			const connector = createTauriConnector(rust);
			const note = createNote("registers", connector);
			await connectPulse(note).synced;
			const other = await loadNote("registers", connector);
			const converged = () =>
				eventually(() => {
					expect(other.title).toBe(note.title);
					for (const pulse of [note, other])
						expect(getPulseMeta(pulse).status).toBe("synced");
				});
			const rewrites = 300;
			for (let i = 0; i < rewrites; i++) {
				// Bursts of concurrent writes, then turns taken once both agree.
				(i % 2 ? note : other).title = `Title ${i}`;
				if (i % 5 === 0) note.tags.push(`tag ${i}`);
				if (i % 20 === 19) await converged();
				else await new Promise((resolve) => setTimeout(resolve, 0));
			}
			for (const pulse of [note, other]) disconnectPulse(pulse);
			await Promise.all([note, other].map((p) => connectPulse(p).synced));
			await converged();
			expect(note.title).toMatch(/^Title 29[89]$/);
			const expected = snapshotPulse(note);
			destroyPulse(other);
			destroyPulse(note);
			// The creation, the tags that were pushed, each client's last title,
			// and a gap row for each client whose first writes were replaced.
			const history = 1 + rewrites / 5;
			const held = (rows: StoredPatchRow[]) =>
				rows.filter((row) => !isGap(row.operations)).length;
			const check = async () => {
				const fresh = await loadNote("registers", createTauriConnector(rust));
				expect(snapshotPulse(fresh)).toEqual(expected);
				destroyPulse(fresh);
				const served = await downloadRows(rust, "registers");
				expect(held(served)).toBe(history + 2);
				// The rows cover every sequence number of every actor exactly once.
				const next = new Map<number, number>();
				for (const row of served) {
					expect(row.clock).toBe(next.get(row.sid) ?? 1);
					next.set(row.sid, row.clock + row.span);
				}
				expect(
					served.filter((row) => isGap(row.operations)).length,
				).toBeLessThanOrEqual(2);
				return served;
			};
			const served = await check();
			expect(await rust.stop()).toBe(0);
			// The values are read back from the database.
			rust = new RustPlugin(path, binary);
			expect(await check()).toEqual(served);
			const again = await loadNote("registers", createTauriConnector(rust));
			for (let i = 0; i < 40; i++) {
				again.title = `Reopened ${i}`;
				disconnectPulse(again);
				await connectPulse(again).synced;
			}
			destroyPulse(again);
			const final = await downloadRows(rust, "registers");
			// One value for the client that wrote them.
			expect(held(final)).toBe(held(served) + 1);
			const last = await loadNote("registers", createTauriConnector(rust));
			expect(last.title).toBe("Reopened 39");
			destroyPulse(last);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);

	test(
		"rows stored through one session reach the document's other sessions",
		async () => {
			const rust = new RustPlugin(join(directory, "live"), binary);
			const connector = createTauriConnector(rust);
			const note = createNote("live", connector);
			await connectPulse(note).synced;
			const other = await loadNote("live", connector);
			other.body.insert(0, "Shared: ");
			other.title = "Live";
			await eventually(() => {
				expect(note.title).toBe("Live");
				expect(note.body.toString()).toBe("Shared: Draft");
			});
			note.tags.push("back");
			await eventually(() => expect([...other.tags]).toEqual(["a", "back"]));
			destroyPulse(other);
			destroyPulse(note);
			expect(await rust.stop()).toBe(0);
		},
		timeout,
	);
});
