import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
	sub,
	pulseRef,
	type Connector,
	type Pulse,
} from "pulsify-core";
import {
	SQLITE_PATCH_SCHEMA,
	SqlitePatchStore,
	type StoredPatchRow,
} from "pulsify-core/storage";
import { createTauriConnector } from "../source/index";
import { createStorePlugin, RustPlugin, rustManifest } from "./plugins";

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
		stats: object({ views: "float64" }),
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
