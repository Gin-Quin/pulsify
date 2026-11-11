import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	destroyPulse,
	encodeMessage,
	decodeMessage,
	PulseError,
	type Connector,
	type ConnectorSession,
} from "pulsify-core";
import {
	createElectronConnector,
	createPulsifyBridge,
	exposePulsifyBridge,
	type PulsifyBridge,
} from "../source/index";
import { servePulsifyStore } from "../source/main";
import { FakeIpcMain, FakeWindow } from "./fakeElectron";
import { createApp, eventually, Note, temporaryFile } from "./helpers";

type Opened = {
	session: ConnectorSession;
	messages: Uint8Array[];
	closes: (Error | undefined)[];
};
async function open(
	connector: Connector,
	docId = "doc",
	signal = new AbortController().signal,
): Promise<Opened> {
	const messages: Uint8Array[] = [];
	const closes: (Error | undefined)[] = [];
	const session = await connector.open({
		docId,
		signal,
		onMessage: (bytes) => messages.push(bytes),
		onClose: (error) => closes.push(error),
	});
	return { session, messages, closes };
}
const connect = (docId = "doc", requestId = 1) =>
	encodeMessage({ kind: 1, docId, requestId, vv: [] });
async function rejection(promise: Promise<unknown>): Promise<PulseError> {
	const error = await promise.then(
		() => {
			throw new Error("Expected a rejection");
		},
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(PulseError);
	return error as PulseError;
}

describe("preload bridge", () => {
	test("exposes only frame IPC under the chosen key", () => {
		const window = new FakeWindow(new FakeIpcMain());
		exposePulsifyBridge(
			{
				contextBridge: window.contextBridge(),
				ipcRenderer: window.ipcRenderer,
			},
			{ key: "storage" },
		);
		const bridge = window.bridge("storage");
		expect(Object.keys(bridge).sort()).toEqual([
			"close",
			"onClose",
			"onMessage",
			"open",
			"send",
		]);
		expect(Object.isFrozen(bridge)).toBe(true);
		const stop = bridge.onMessage(() => {});
		expect(window.ipcRenderer.listenerCount("pulsify:message")).toBe(1);
		stop();
		expect(window.ipcRenderer.listenerCount()).toBe(0);
	});

	test("frames travel as Uint8Array, responses arrive asynchronously", async () => {
		const app = createApp(new Database(":memory:"));
		const { connector } = app.openWindow();
		const opened = await open(connector);
		expect(opened.session.protocolVersion).toBe(2);
		const sending = opened.session.send(connect());
		expect(opened.messages).toHaveLength(0);
		await sending;
		await eventually(() => expect(opened.messages).toHaveLength(1));
		const reply = decodeMessage(opened.messages[0]!);
		expect(reply).toMatchObject({ kind: 2, requestId: 1, found: false });
		const [, , frame] = app.ipcMain.received.find(
			([channel]) => channel === "pulsify:send",
		)!;
		expect(frame).toBeInstanceOf(Uint8Array);
		expect(opened.messages[0]).toBeInstanceOf(Uint8Array);
		opened.session.close();
		await app.server.close();
	});

	test("the main process validates requests and session ownership", async () => {
		const app = createApp(new Database(":memory:"));
		const a = app.openWindow();
		const b = app.openWindow();
		const bridge: PulsifyBridge = a.window.bridge();
		expect(await bridge.open("", "doc")).toMatchObject({
			ok: false,
			code: "INVALID_MESSAGE",
		});
		expect(await bridge.open("s1", "doc")).toEqual({ ok: true });
		expect(await bridge.open("s1", "doc")).toMatchObject({
			ok: false,
			code: "INVALID_MESSAGE",
		});
		expect(
			await bridge.send("s1", [1, 2, 3] as unknown as Uint8Array),
		).toMatchObject({ ok: false, code: "INVALID_MESSAGE" });
		expect(await bridge.send("s1", new Uint8Array([1, 2]))).toMatchObject({
			ok: false,
		});
		expect(await b.window.bridge().send("s1", connect())).toMatchObject({
			ok: false,
			code: "CLOSED",
		});
		expect(
			await bridge.send("s1", connect("other")).then(async (result) => {
				await new Promise((resolve) => setImmediate(resolve));
				return result;
			}),
		).toEqual({ ok: true });
		const reply = a.window.webContents.sent.at(-1)!;
		expect(reply[0]).toBe("pulsify:message");
		const message = decodeMessage(reply[2] as Uint8Array);
		expect(message.kind === 6 && message.code).toBe("INVALID_MESSAGE");
		await bridge.close("s1");
		expect(await bridge.send("s1", connect())).toMatchObject({
			ok: false,
			code: "CLOSED",
		});
		await app.server.close();
	});
});

describe("connector lifecycle", () => {
	test("an unavailable main process rejects open with CONNECTION_FAILED", async () => {
		const window = new FakeWindow(new FakeIpcMain());
		const connector = createElectronConnector(
			createPulsifyBridge(window.ipcRenderer),
		);
		expect((await rejection(open(connector))).code).toBe("CONNECTION_FAILED");
		expect(
			(await rejection(open(createElectronConnector("missing")))).code,
		).toBe("CONNECTION_FAILED");
		expect(window.ipcRenderer.listenerCount()).toBe(0);

		const scope = createPulseScope();
		const note = createPulse(
			Note,
			{ title: "Nowhere", body: "", tags: [], meta: { count: 0 } },
			{ scope, connectors: [connector], timeoutMs: 200 },
		);
		const error = await rejection(connectPulse(note).connected);
		expect(["CONNECTION_FAILED", "TIMEOUT"]).toContain(error.code);
		destroyPulse(note);
	});

	test("a database that cannot be opened rejects open with CONNECTION_FAILED", async () => {
		const ipcMain = new FakeIpcMain();
		const server = servePulsifyStore({
			ipcMain,
			database: `${temporaryFile()}/missing/pulsify.sqlite`,
		});
		await expect(server.ready).rejects.toThrow();
		const window = new FakeWindow(ipcMain);
		const connector = createElectronConnector(
			createPulsifyBridge(window.ipcRenderer),
		);
		const error = await rejection(open(connector));
		expect(error.code).toBe("CONNECTION_FAILED");
		expect(error.message).toContain("Cannot open the Pulsify database");
		await server.close();
	});

	test("the global bridge is used by default", async () => {
		const app = createApp(new Database(":memory:"));
		const { window } = app.openWindow();
		const global = globalThis as Record<string, unknown>;
		global["pulsify"] = window.bridge();
		try {
			const opened = await open(createElectronConnector());
			opened.session.close();
		} finally {
			delete global["pulsify"];
		}
		await app.server.close();
	});

	test("abort signals close sessions before and after opening", async () => {
		const app = createApp(new Database(":memory:"));
		const { window, connector } = app.openWindow();
		const aborted = new AbortController();
		aborted.abort();
		expect((await rejection(open(connector, "doc", aborted.signal))).code).toBe(
			"CLOSED",
		);

		const opening = new AbortController();
		const pending = open(connector, "doc", opening.signal);
		opening.abort();
		expect((await rejection(pending)).code).toBe("CLOSED");
		await eventually(() => expect(window.webContents.listenerCount()).toBe(0));
		expect(window.ipcRenderer.listenerCount()).toBe(0);

		const live = new AbortController();
		const opened = await open(connector, "doc", live.signal);
		expect(window.webContents.listenerCount()).toBeGreaterThan(0);
		live.abort();
		expect(opened.closes).toHaveLength(1);
		expect((opened.closes[0] as PulseError).code).toBe("CLOSED");
		expect((await rejection(opened.session.send(connect()))).code).toBe(
			"CLOSED",
		);
		await eventually(() => expect(window.webContents.listenerCount()).toBe(0));
		await app.server.close();
	});

	test("closing the store closes renderer sessions with CLOSED", async () => {
		const file = temporaryFile();
		const ipcMain = new FakeIpcMain();
		let server = servePulsifyStore({ ipcMain, database: file });
		const window = new FakeWindow(ipcMain);
		exposePulsifyBridge({
			contextBridge: window.contextBridge(),
			ipcRenderer: window.ipcRenderer,
		});
		const connector = createElectronConnector(window.bridge());
		const first = await open(connector, "a");
		const second = await open(connector, "b");
		await server.close();
		await eventually(() => {
			expect(first.closes).toHaveLength(1);
			expect(second.closes).toHaveLength(1);
		});
		expect((first.closes[0] as PulseError).code).toBe("CLOSED");
		expect(window.ipcRenderer.listenerCount()).toBe(0);
		expect((await rejection(open(connector, "a"))).code).toBe(
			"CONNECTION_FAILED",
		);

		server = servePulsifyStore({ ipcMain, database: file });
		const again = await open(connector, "a");
		await again.session.send(connect("a"));
		await eventually(() => expect(again.messages).toHaveLength(1));
		again.session.close();
		await server.close();
	});

	test("a session dropped by the main process fails on send", async () => {
		const app = createApp(new Database(":memory:"));
		const { window, connector } = app.openWindow();
		const opened = await open(connector);
		window.webContents.emit(
			"did-frame-navigate",
			{},
			"app://",
			200,
			"OK",
			true,
			7,
			1,
		);
		expect((await rejection(opened.session.send(connect()))).code).toBe(
			"CLOSED",
		);
		expect((opened.closes[0] as PulseError).code).toBe("CLOSED");
		await app.server.close();
	});

	test("subframe navigation drops only that frame's sessions", async () => {
		const app = createApp(new Database(":memory:"));
		const { window, connector: main } = app.openWindow();
		const frame = window.frame(2);
		const sub = createElectronConnector(createPulsifyBridge(frame));
		const top = await open(main, "doc");
		const child = await open(sub, "doc");
		await child.session.send(connect());
		await eventually(() => expect(child.messages).toHaveLength(1));
		window.navigateFrame(2);
		await top.session.send(connect());
		await eventually(() => expect(top.messages).toHaveLength(1));
		expect((await rejection(child.session.send(connect()))).code).toBe(
			"CLOSED",
		);
		top.session.close();
		await app.server.close();
	});

	test("a window that disappears mid-session reports CONNECTION_FAILED", async () => {
		const app = createApp(new Database(":memory:"));
		const { window, connector } = app.openWindow();
		const opened = await open(connector);
		window.destroy();
		expect((await rejection(opened.session.send(connect()))).code).toBe(
			"CONNECTION_FAILED",
		);
		expect((opened.closes[0] as PulseError).code).toBe("CONNECTION_FAILED");
		await app.server.close();
	});
});
