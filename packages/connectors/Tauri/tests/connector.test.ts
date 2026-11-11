import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { array, object } from "@gin-quin/codec";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	loadPulse,
	PulseError,
	richText,
	snapshotPulse,
} from "@pulsify/core";
import { SqlitePatchStore } from "@pulsify/core/storage";
import {
	createTauriConnector,
	TAURI_SESSION_HEADER,
	type TauriInvoke,
} from "../source/index";
import { createStorePlugin, type FakeChannel } from "./plugins";

type Call = { command: string; args: unknown; options: unknown };
/** Records invocations; `open` returns increasing session IDs unless scripted. */
function mockInvoke(
	script: (call: Call) => unknown = (call) =>
		call.command.endsWith("|open") ? 1 : null,
) {
	const calls: Call[] = [];
	const channels: FakeChannel[] = [];
	const invoke: TauriInvoke = async (command, args, options) => {
		const call = { command, args, options };
		calls.push(call);
		if (command.endsWith("|open"))
			channels.push((args as { channel: FakeChannel }).channel);
		return script(call);
	};
	const createChannel = (onMessage: (message: unknown) => void) => ({
		onMessage,
	});
	return {
		calls,
		channels,
		connector: createTauriConnector({ invoke, createChannel }),
	};
}
function input(controller = new AbortController()) {
	const messages: Uint8Array[] = [];
	const closes: (Error | undefined)[] = [];
	return {
		messages,
		closes,
		controller,
		input: {
			docId: "doc",
			signal: controller.signal,
			onMessage: (bytes: Uint8Array) => messages.push(bytes),
			onClose: (error?: Error) => closes.push(error),
		},
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function rejection(promise: Promise<unknown>): Promise<PulseError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PulseError);
		return error as PulseError;
	}
	throw new Error("Expected a rejection");
}

const Note = definePulse(
	"TauriNote",
	object({
		title: "string",
		body: richText(),
		tags: array("string"),
		stats: object({ views: "float64" }),
	}),
).materialize();

describe("createTauriConnector", () => {
	test("opens a pinned session, sends raw frames with its ID and closes it", async () => {
		const { calls, channels, connector } = mockInvoke((call) =>
			call.command.endsWith("|open") ? 7 : null,
		);
		const { messages, closes, input: options } = input();
		expect(connector.kind).toBe("local");
		const session = await connector.open(options);
		expect(session.protocolVersion).toBe(2);
		expect(calls[0]).toMatchObject({
			command: "plugin:pulsify|open",
			args: { docId: "doc" },
		});
		const frame = new Uint8Array([1, 2, 3]);
		await session.send(frame);
		expect(calls[1]).toEqual({
			command: "plugin:pulsify|send",
			args: frame,
			options: { headers: { [TAURI_SESSION_HEADER]: "7" } },
		});
		channels[0]!.onMessage(new Uint8Array([4, 5]).buffer);
		channels[0]!.onMessage([6]);
		expect(messages).toEqual([new Uint8Array([4, 5]), new Uint8Array([6])]);
		session.close();
		session.close();
		expect(calls.slice(2)).toEqual([
			{
				command: "plugin:pulsify|close",
				args: { sessionId: 7 },
				options: undefined,
			},
		]);
		channels[0]!.onMessage(new Uint8Array([7]).buffer);
		expect(messages.length).toBe(2);
		expect(closes).toEqual([]);
		expect((await rejection(session.send(frame))).code).toBe("CLOSED");
		expect(calls.length).toBe(3);
	});

	test("honours a custom plugin name", async () => {
		const calls: string[] = [];
		const connector = createTauriConnector({
			plugin: "storage",
			createChannel: () => ({}),
			invoke: async (command) => {
				calls.push(command);
				return 1;
			},
		});
		const session = await connector.open(input().input);
		session.close();
		expect(calls).toEqual(["plugin:storage|open", "plugin:storage|close"]);
	});

	test("an aborted signal never reaches the plugin", async () => {
		const { calls, connector } = mockInvoke();
		const controller = new AbortController();
		controller.abort();
		const failure = await rejection(connector.open(input(controller).input));
		expect(failure.code).toBe("CLOSED");
		expect(calls).toEqual([]);
	});

	test("aborting while opening releases the session once it exists", async () => {
		let resolve!: (id: number) => void;
		const { calls, connector } = mockInvoke((call) =>
			call.command.endsWith("|open")
				? new Promise((done) => (resolve = done))
				: null,
		);
		const { controller, closes, input: options } = input();
		const opening = connector.open(options);
		controller.abort();
		resolve(3);
		expect((await rejection(opening)).code).toBe("CLOSED");
		expect(closes.map((error) => (error as PulseError).code)).toEqual([
			"CLOSED",
		]);
		expect(calls.map((call) => call.command)).toEqual([
			"plugin:pulsify|open",
			"plugin:pulsify|close",
		]);
		expect(calls[1]!.args).toEqual({ sessionId: 3 });
	});

	test("aborting an open session closes it and reports CLOSED", async () => {
		const { calls, connector } = mockInvoke();
		const { controller, closes, input: options } = input();
		const session = await connector.open(options);
		controller.abort();
		expect((closes[0] as PulseError).code).toBe("CLOSED");
		expect(calls.at(-1)!.command).toBe("plugin:pulsify|close");
		expect((await rejection(session.send(new Uint8Array([1])))).code).toBe(
			"CLOSED",
		);
		session.close();
		expect(closes.length).toBe(1);
	});

	test("open failures become PulseErrors", async () => {
		const cases: [unknown, PulseError["code"]][] = [
			["IPC unavailable", "CONNECTION_FAILED"],
			[new Error("boom"), "CONNECTION_FAILED"],
			[
				{ code: "INVALID_MESSAGE", message: "Invalid document ID" },
				"INVALID_MESSAGE",
			],
			[{ code: "SQLITE_BUSY", message: "busy" }, "CONNECTION_FAILED"],
			["pulsify.open not allowed. Permissions associated…", "FORBIDDEN"],
		];
		for (const [thrown, code] of cases) {
			const { connector } = mockInvoke(() => {
				throw thrown;
			});
			const { closes, input: options } = input();
			expect((await rejection(connector.open(options))).code).toBe(code);
			expect(closes).toEqual([]);
		}
		const { connector } = mockInvoke(() => "not a session");
		expect((await rejection(connector.open(input().input))).code).toBe(
			"CONNECTION_FAILED",
		);
	});

	test("transient send failures close the session; invalid frames only reject", async () => {
		let failure: unknown;
		const { calls, connector } = mockInvoke((call) => {
			if (call.command.endsWith("|open")) return 1;
			if (call.command.endsWith("|send")) throw failure;
			return null;
		});
		const { closes, input: options } = input();
		const session = await connector.open(options);
		failure = { code: "INVALID_MESSAGE", message: "Truncated frame" };
		expect((await rejection(session.send(new Uint8Array([1])))).code).toBe(
			"INVALID_MESSAGE",
		);
		expect(closes).toEqual([]);
		failure = { code: "CLOSED", message: "Unknown or closed session" };
		expect((await rejection(session.send(new Uint8Array([1])))).code).toBe(
			"CLOSED",
		);
		expect((closes[0] as PulseError).code).toBe("CLOSED");
		expect(calls.at(-1)!.command).toBe("plugin:pulsify|close");
		expect((await rejection(session.send(new Uint8Array([1])))).code).toBe(
			"CLOSED",
		);
		expect(closes.length).toBe(1);
	});

	test("a non-binary channel message closes with INVALID_MESSAGE", async () => {
		const { channels, connector } = mockInvoke();
		const { closes, messages, input: options } = input();
		await connector.open(options);
		channels[0]!.onMessage("text");
		channels[0]!.onMessage(new Uint8Array([1]).buffer);
		expect((closes[0] as PulseError).code).toBe("INVALID_MESSAGE");
		expect(messages).toEqual([]);
	});
});

describe("documents through the plugin contract", () => {
	test("persist, reload and broadcast live across sessions", async () => {
		const store = new SqlitePatchStore(new Database(":memory:"));
		const plugin = createStorePlugin(store);
		const connector = createTauriConnector(plugin);
		const note = createPulse(
			Note,
			{
				id: "notes/1",
				title: "Hello",
				body: "Rich",
				tags: ["a"],
				stats: { views: 1 },
			},
			{ scope: createPulseScope(), connectors: [connector] },
		);
		await connectPulse(note).synced;
		note.body.insert(4, " text");
		note.tags.push("b");
		for (let i = 2; i <= 50; i++) note.stats.views = i;
		await connectPulse(note).synced;
		expect((await store.vector("notes/1")).length).toBe(1);

		const other = await loadPulse(Note, "notes/1", {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(snapshotPulse(other)).toEqual(snapshotPulse(note));
		expect(other.body.toString()).toBe("Rich text");
		other.title = "Edited elsewhere";
		await eventually(() => expect(note.title).toBe("Edited elsewhere"));
		expect([...plugin.sessions.values()].map((s) => s.docId)).toEqual([
			"notes/1",
			"notes/1",
		]);
		destroyPulse(other);
		destroyPulse(note);
		expect(plugin.sessions.size).toBe(0);
	});

	test("a dropped session fails the connection; the next open() resumes", async () => {
		const store = new SqlitePatchStore(new Database(":memory:"));
		const plugin = createStorePlugin(store);
		const errors: Error[] = [];
		const note = createPulse(
			Note,
			{ id: "drop", title: "A", body: "", tags: [], stats: { views: 0 } },
			{
				scope: createPulseScope(),
				connectors: [createTauriConnector(plugin)],
				reconnect: false,
				onError: (error) => errors.push(error),
			},
		);
		await connectPulse(note).synced;
		plugin.sessions.clear();
		note.title = "B";
		await eventually(() =>
			expect(
				errors.some((error) => (error as PulseError).code === "CLOSED"),
			).toBe(true),
		);
		disconnectPulse(note);
		await connectPulse(note).synced;
		const reloaded = await loadPulse(Note, "drop", {
			scope: createPulseScope(),
			connectors: [createTauriConnector(plugin)],
			waitFor: "all",
		});
		expect(reloaded.title).toBe("B");
		destroyPulse(reloaded);
		destroyPulse(note);
	});
});

async function eventually(assertion: () => void, timeout = 2000) {
	const end = performance.now() + timeout;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await tick();
	}
}
