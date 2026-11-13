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
	loadPulse,
	richText,
	snapshotPulse,
	type Connector,
} from "../packages/pulse/source/index";
import { createTauriConnector } from "../packages/connectors/Tauri/source/index";
import { RustPlugin } from "../packages/connectors/Tauri/tests/plugins";

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
		stats: object({ views: "float64" }),
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
