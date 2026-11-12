import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	pulseRef,
} from "pulsify-core";
import { servePulsifyStore } from "../source/main";
import {
	createApp,
	eventually,
	Note,
	Notebook,
	persisted,
	temporaryFile,
} from "./helpers";

function destroyAll(scope: ReturnType<typeof createPulseScope>) {
	for (const pulse of [...scope.pulses.values()]) destroyPulse(pulse);
}

describe("persistence", () => {
	test("documents survive an app restart", async () => {
		const file = temporaryFile();
		const first = createApp(file);
		await first.server.ready;
		const { connector } = first.openWindow();
		const scope = createPulseScope();
		const notebook = createPulse(
			Notebook,
			{ id: "notebook", name: "Ideas", notes: [] },
			{ scope, connectors: [connector] },
		);
		const note = createPulse(
			Note,
			{ title: "First", body: "Hello", tags: ["a"], meta: { count: 1 } },
			{ parent: notebook },
		);
		notebook.notes.push(pulseRef(note));
		await Promise.all([
			connectPulse(notebook).synced,
			connectPulse(note).synced,
		]);
		note.body.insert(5, " world 😀");
		note.body.format(0, 5, { bold: true });
		note.tags.push("b");
		note.meta.count = 2;
		notebook.name = "Ideas & plans";
		await Promise.all([persisted(notebook), persisted(note)]);
		const delta = note.body.toDelta();
		const noteId = note.id;
		destroyAll(scope);
		await first.server.close();

		const reopened = new Database(file, { readonly: true });
		expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
		reopened.close();

		const second = createApp(file);
		const window = second.openWindow();
		const restarted = createPulseScope();
		const loaded = await loadPulse(Notebook, "notebook", {
			scope: restarted,
			connectors: [window.connector],
			waitFor: "all",
		});
		expect(loaded.name).toBe("Ideas & plans");
		const child = loaded.notes[0]!.pulse!;
		expect(child.id).toBe(noteId);
		expect(child.title).toBe("First");
		expect(child.body.toString()).toBe("Hello world 😀");
		expect(child.body.toDelta()).toEqual(delta);
		expect([...child.tags]).toEqual(["a", "b"]);
		expect(child.meta.count).toBe(2);

		child.title = "Edited after restart";
		await persisted(child);
		destroyAll(restarted);
		await second.server.close();
	});

	test("a caller-owned database stays open after close()", async () => {
		const database = new Database(":memory:");
		const app = createApp(database);
		const { connector } = app.openWindow();
		const scope = createPulseScope();
		const note = createPulse(
			Note,
			{ title: "Memory", body: "", tags: [], meta: { count: 0 } },
			{ scope, connectors: [connector] },
		);
		await connectPulse(note).synced;
		destroyAll(scope);
		await app.server.close();
		expect(database.open).toBe(true);
		const count = database
			.prepare("SELECT COUNT(*) AS count FROM pulsify_op_rows")
			.get() as { count: number };
		expect(count.count).toBeGreaterThan(0);
		database.close();
	});
});

describe("windows", () => {
	test("windows see each other's changes; destroyed windows are cleaned up", async () => {
		const app = createApp(new Database(":memory:"));
		const a = app.openWindow();
		const b = app.openWindow();
		const scopeA = createPulseScope();
		const scopeB = createPulseScope();
		const noteA = createPulse(
			Note,
			{ id: "shared", title: "Shared", body: "", tags: [], meta: { count: 0 } },
			{ scope: scopeA, connectors: [a.connector] },
		);
		await connectPulse(noteA).synced;
		const noteB = await loadPulse(Note, "shared", {
			scope: scopeB,
			connectors: [b.connector],
			waitFor: "all",
		});
		expect(noteB.title).toBe("Shared");

		noteA.title = "From A";
		await eventually(() => expect(noteB.title).toBe("From A"));
		noteB.body.insert(0, "From B");
		noteB.tags.push("b");
		await eventually(() => expect(noteA.body.toString()).toBe("From B"));
		expect([...noteA.tags]).toEqual(["b"]);

		expect(b.window.webContents.listenerCount("destroyed")).toBe(1);
		b.window.destroy();
		expect(b.window.webContents.listenerCount()).toBe(0);
		const sent = b.window.webContents.sent.length;
		noteA.meta.count = 5;
		await persisted(noteA);
		expect(b.window.webContents.sent.length).toBe(sent);

		const c = app.openWindow();
		const noteC = await loadPulse(Note, "shared", {
			scope: createPulseScope(),
			connectors: [c.connector],
			waitFor: "all",
		});
		expect(noteC.meta.count).toBe(5);
		noteA.title = "To C";
		await eventually(() => expect(noteC.title).toBe("To C"));

		destroyPulse(noteB);
		destroyPulse(noteC);
		destroyAll(scopeA);
		await eventually(() =>
			expect(a.window.webContents.listenerCount()).toBe(0),
		);
		await app.server.close();
	});

	test("a reloaded window loses its sessions; documents are isolated", async () => {
		const app = createApp(new Database(":memory:"));
		const a = app.openWindow();
		const b = app.openWindow();
		const scope = createPulseScope();
		const one = createPulse(
			Note,
			{ id: "one", title: "One", body: "", tags: [], meta: { count: 0 } },
			{ scope, connectors: [a.connector] },
		);
		const two = createPulse(
			Note,
			{ id: "two", title: "Two", body: "", tags: [], meta: { count: 0 } },
			{ scope, connectors: [a.connector] },
		);
		await Promise.all([connectPulse(one).synced, connectPulse(two).synced]);
		const watcher = await loadPulse(Note, "two", {
			scope: createPulseScope(),
			connectors: [b.connector],
			waitFor: "all",
		});
		const frames = b.window.webContents.sent.length;
		one.title = "Changed";
		await persisted(one);
		expect(b.window.webContents.sent.length).toBe(frames);

		a.window.reload();
		expect(a.window.webContents.listenerCount()).toBe(0);
		await app.server.close();
		destroyAll(scope);
		destroyPulse(watcher);
	});
});

describe("offline first", () => {
	test("edits stay local until a remote connector can sync them", async () => {
		const file = temporaryFile();
		const relay = new PulseRelay();
		const remote = createMemoryConnector(relay, "remote");

		// Offline: the document only exists on this device.
		let app = createApp(file);
		let local = app.openWindow().connector;
		let scope = createPulseScope();
		const trip = createPulse(
			Note,
			{ id: "trip", title: "Trip", body: "Pack", tags: [], meta: { count: 0 } },
			{ scope, connectors: [local] },
		);
		await connectPulse(trip).synced;
		trip.tags.push("offline");
		await persisted(trip);
		destroyAll(scope);
		await app.server.close();
		await expect(
			loadPulse(Note, "trip", {
				scope: createPulseScope(),
				connectors: [remote],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Online: local data loads first, then uploads to the remote.
		app = createApp(file);
		local = app.openWindow().connector;
		scope = createPulseScope();
		let device = await loadPulse(Note, "trip", {
			scope,
			connectors: [local, remote],
			waitFor: "all",
		});
		expect(device.tags[0]).toBe("offline");
		const other = await loadPulse(Note, "trip", {
			scope: createPulseScope(),
			connectors: [remote],
			waitFor: "all",
		});
		expect(other.body.toString()).toBe("Pack");
		destroyAll(scope);

		// Concurrent edits: another device online, this one offline.
		other.title = "Trip to Lisbon";
		await persisted(other);
		scope = createPulseScope();
		device = await loadPulse(Note, "trip", {
			scope,
			connectors: [local],
			waitFor: "all",
		});
		device.body.insert(4, " bags");
		await persisted(device);
		destroyAll(scope);

		// Back online: both sides converge and the merge is stored locally.
		scope = createPulseScope();
		device = await loadPulse(Note, "trip", {
			scope,
			connectors: [local, remote],
			waitFor: "all",
		});
		expect(device.title).toBe("Trip to Lisbon");
		expect(device.body.toString()).toBe("Pack bags");
		await eventually(() => expect(other.body.toString()).toBe("Pack bags"));
		await persisted(device);
		destroyAll(scope);
		destroyPulse(other);
		await app.server.close();

		app = createApp(file);
		const restored = await loadPulse(Note, "trip", {
			scope: createPulseScope(),
			connectors: [app.openWindow().connector],
			waitFor: "all",
		});
		expect(restored.title).toBe("Trip to Lisbon");
		expect(restored.body.toString()).toBe("Pack bags");
		destroyPulse(restored);
		await app.server.close();
	});

	test("connected pulses reconnect on their own when the main process store restarts", async () => {
		const file = temporaryFile();
		const app = createApp(file);
		const { connector } = app.openWindow();
		const scope = createPulseScope();
		const errors: Error[] = [];
		const note = createPulse(
			Note,
			{ title: "Before", body: "", tags: [], meta: { count: 0 } },
			{
				scope,
				connectors: [connector],
				reconnect: { initialDelayMs: 2, maxDelayMs: 10, factor: 2, jitter: 0 },
				onError: (error) => errors.push(error),
			},
		);
		await connectPulse(note).synced;
		await app.server.close();
		await eventually(() => expect(getPulseMeta(note).status).toBe("offline"));
		note.title = "Written while the store was down";
		await new Promise((resolve) => setTimeout(resolve, 30));
		const restarted = servePulsifyStore({
			ipcMain: app.ipcMain,
			database: file,
		});
		await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
		expect(errors.map((error) => (error as { code?: string }).code)).toEqual([
			"CLOSED",
		]);
		const id = note.id;
		destroyAll(scope);
		const reloaded = await loadPulse(Note, id, {
			scope: createPulseScope(),
			connectors: [app.openWindow().connector],
			waitFor: "all",
		});
		expect(reloaded.title).toBe("Written while the store was down");
		destroyPulse(reloaded);
		await restarted.close();
	});

	test("a pulse reconnects through new sessions many times", async () => {
		const app = createApp(new Database(":memory:"));
		const { connector } = app.openWindow();
		const scope = createPulseScope();
		const note = createPulse(
			Note,
			{ title: "Again", body: "", tags: [], meta: { count: 0 } },
			{ scope, connectors: [connector] },
		);
		for (let i = 1; i <= 4; i++) {
			await connectPulse(note).synced;
			disconnectPulse(note);
			note.meta.count = i;
		}
		await connectPulse(note).synced;
		const copy = await loadPulse(Note, note.id, {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(copy.meta.count).toBe(4);
		destroyPulse(copy);
		destroyAll(scope);
		await app.server.close();
	});
});
