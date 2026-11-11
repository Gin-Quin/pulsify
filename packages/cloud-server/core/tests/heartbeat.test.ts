import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	setOnlineMode,
	type Pulse,
} from "@pulsify/core";
import {
	createCloudClient,
	createCloudConnector,
	signCloudToken,
	createPresence,
	type CloudConnectorOptions,
	type PresenceOptions,
} from "@pulsify/cloud";
import { eventually, Note, Workspace } from "./conformance.js";
import { startCloudHost } from "./host.js";

const secrets = {
	tokenSecret: "a test token secret of at least 32 characters",
	apiKey: "a test api key of at least thirty-two characters",
};
let host: ReturnType<typeof startCloudHost>;
beforeAll(() => {
	host = startCloudHost(secrets);
});
afterAll(() => host.stop());

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	host.thaw();
	setOnlineMode(true);
});
const reconnect = { initialDelayMs: 5, maxDelayMs: 20, factor: 2, jitter: 0 };

/** A workspace and a note of one root, on one connector: one socket. */
type Heartbeat = Exclude<CloudConnectorOptions["heartbeat"], false | undefined>;
async function open(settings: (Heartbeat & PresenceOptions) | false) {
	const { activeMs, unfocusedMs, ...rest } = settings || {};
	const heartbeat = settings === false ? false : rest;
	const presence = createPresence({
		...(activeMs === undefined ? {} : { activeMs }),
		...(unfocusedMs === undefined ? {} : { unfocusedMs }),
	});
	const root = `heartbeat-${crypto.randomUUID().slice(0, 8)}`;
	await createCloudClient({ url: host.url, credential: secrets.apiKey }).grant({
		subject: "alice",
		prefix: root,
		role: "owner",
	});
	const cloud = createCloudConnector({
		url: host.url,
		token: () => signCloudToken({ subject: "alice" }, secrets.tokenSecret),
		heartbeat,
		presence,
	});
	const options = {
		scope: createPulseScope(),
		connectors: [cloud],
		reconnect,
		timeoutMs: 2_000,
	};
	const workspace = createPulse(
		Workspace,
		{ id: root, name: "Heartbeat", notes: [] },
		options,
	);
	const note = createPulse(
		Note,
		{ title: "Ping", body: "" },
		{ parent: workspace },
	);
	await Promise.all(
		[workspace, note].map((pulse) => connectPulse(pulse).synced),
	);
	cleanup.push(() => {
		for (const pulse of [note, workspace] as Pulse<any>[]) destroyPulse(pulse);
		cloud.close();
		presence.dispose();
	});
	const reconnections = () =>
		[workspace, note].reduce(
			(count, pulse) => count + getPulseMeta(pulse).connections[0]!.attempt,
			0,
		);
	return { cloud, presence, workspace, note, reconnections };
}

describe("cloud socket heartbeat", () => {
	test("an idle socket pings once per interval for all its documents and stays open", async () => {
		const { cloud, workspace, note } = await open({
			intervalMs: 40,
			timeoutMs: 40,
		});
		expect(cloud.connections).toHaveLength(1);
		const before = host.pings;
		await Bun.sleep(260);
		const pings = host.pings - before;
		// One socket for two documents: about one ping per interval, not two.
		expect(pings).toBeGreaterThanOrEqual(3);
		expect(pings).toBeLessThanOrEqual(7);
		expect(getPulseMeta(workspace).status).toBe("synced");
		expect(getPulseMeta(note).status).toBe("synced");
		expect(cloud.connections).toHaveLength(1);
	});

	test("traffic proves the socket alive: no ping while frames flow", async () => {
		const { note } = await open({ intervalMs: 60, timeoutMs: 60 });
		const before = host.pings;
		for (let i = 0; i < 20; i++) {
			note.title = `Busy ${i}`;
			await Bun.sleep(10);
		}
		expect(host.pings - before).toBe(0);
	});

	test("a socket that stops answering is closed; its documents reconnect and sync", async () => {
		const { cloud, workspace, note } = await open({
			intervalMs: 30,
			timeoutMs: 40,
		});
		host.freeze();
		await eventually(() => {
			expect(getPulseMeta(workspace).status).toBe("offline");
			expect(getPulseMeta(note).status).toBe("offline");
		});
		note.title = "Written while the socket was dead";
		host.thaw();
		await eventually(() => {
			expect(getPulseMeta(workspace).status).toBe("synced");
			expect(getPulseMeta(note).status).toBe("synced");
		});
		expect(cloud.connections).toHaveLength(1);
		const reader = createCloudConnector({
			url: host.url,
			token: () => signCloudToken({ subject: "alice" }, secrets.tokenSecret),
		});
		const copy = await loadPulse(Note, note.id, {
			scope: createPulseScope(),
			connectors: [reader],
		});
		expect(copy.title).toBe("Written while the socket was dead");
		destroyPulse(copy);
		reader.close();
	});

	test("the network coming back checks every socket at once", async () => {
		const { workspace, reconnections } = await open({
			intervalMs: 60_000,
			timeoutMs: 50,
		});
		const before = host.pings;
		setOnlineMode(true);
		await eventually(() => expect(host.pings - before).toBe(1));
		await Bun.sleep(80);
		expect(reconnections()).toBe(0);

		host.freeze();
		setOnlineMode(true);
		await eventually(() =>
			expect(getPulseMeta(workspace).status).toBe("offline"),
		);
		host.thaw();
		await eventually(() =>
			expect(getPulseMeta(workspace).status).toBe("synced"),
		);
	});

	test("lazy waking: an idle socket stays silent; the first edit after a silence checks it", async () => {
		const { cloud, workspace, note } = await open({
			intervalMs: false,
			staleMs: 40,
			timeoutMs: 40,
		});
		const before = host.pings;
		await Bun.sleep(150);
		expect(host.pings - before).toBe(0);

		// Alive: one ping goes out with the edit, nothing reconnects.
		note.title = "After a silence";
		await eventually(() => expect(host.pings - before).toBe(1));
		await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
		// A frame was just received: the next edit needs no ping.
		note.title = "Right after";
		await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
		expect(host.pings - before).toBe(1);

		// Dead: the ping sent with the edit gets no answer, the socket is replaced.
		await Bun.sleep(60);
		host.freeze();
		note.title = "Into a dead socket";
		await eventually(() => {
			expect(getPulseMeta(note).status).toBe("offline");
			expect(getPulseMeta(workspace).status).toBe("offline");
		});
		host.thaw();
		await eventually(() => {
			expect(getPulseMeta(note).status).toBe("synced");
			expect(getPulseMeta(workspace).status).toBe("synced");
		});
		expect(cloud.connections).toHaveLength(1);
	});

	test("coming back to the page checks stale sockets only", async () => {
		await open({ intervalMs: false, staleMs: 40, timeoutMs: 1_000 });
		const before = host.pings;
		globalThis.dispatchEvent(new Event("focus"));
		await Bun.sleep(20);
		expect(host.pings - before).toBe(0);
		await Bun.sleep(40);
		globalThis.dispatchEvent(new Event("focus"));
		await eventually(() => expect(host.pings - before).toBe(1));
	});

	test("heartbeat: false sends no ping", async () => {
		await open(false);
		const before = host.pings;
		await Bun.sleep(100);
		setOnlineMode(true);
		await Bun.sleep(20);
		expect(host.pings - before).toBe(0);
	});
});

describe("a page left open lets the server sleep", () => {
	/** A minimal page: visibility and its change event. */
	class Page extends EventTarget {
		visibilityState: "visible" | "hidden" = "visible";
		hasFocus() {
			return true;
		}
		show(state: "visible" | "hidden") {
			this.visibilityState = state;
			this.dispatchEvent(new Event("visibilitychange"));
		}
	}
	let page: Page;
	beforeEach(() => {
		page = new Page();
		Object.assign(globalThis, { document: page });
	});
	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	test("a hidden page sends no background ping and checks its sockets when shown", async () => {
		await open({ intervalMs: 30, staleMs: 30, timeoutMs: 1_000 });
		page.show("hidden");
		const before = host.pings;
		await Bun.sleep(200);
		expect(host.pings - before).toBe(0);
		page.show("visible");
		await eventually(() => expect(host.pings - before).toBe(1));
	});

	test("a visible page nobody touches stops pinging; the next input checks at once", async () => {
		await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 1_000,
			activeMs: 100,
		});
		await Bun.sleep(120);
		const before = host.pings;
		await Bun.sleep(200);
		expect(host.pings - before).toBe(0);
		globalThis.dispatchEvent(new Event("keydown"));
		await eventually(() => expect(host.pings - before).toBe(1));
		// Active again: background pings resume.
		await eventually(() =>
			expect(host.pings - before).toBeGreaterThanOrEqual(2),
		);
	});

	test("an edit from a hidden page still checks a silent socket", async () => {
		const { note } = await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 40,
		});
		page.show("hidden");
		await Bun.sleep(60);
		host.freeze();
		note.title = "Background sync";
		await eventually(() => expect(getPulseMeta(note).status).toBe("offline"));
		host.thaw();
		await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
	});
	test("a webview that always reports visible stops pinging once input stops", async () => {
		// WebView2 in Tauri never reports a hidden page (tauri-apps/tauri#10592).
		await open({ intervalMs: 30, staleMs: 30, timeoutMs: 1_000, activeMs: 80 });
		await Bun.sleep(100);
		const before = host.pings;
		await Bun.sleep(150);
		expect(page.visibilityState).toBe("visible");
		expect(host.pings - before).toBe(0);
		globalThis.dispatchEvent(new Event("pointerdown"));
		await eventually(() => expect(host.pings - before).toBe(1));
	});

	test("native signals: presence.set(false) silences a visible page until presence.set(true)", async () => {
		const { presence } = await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 1_000,
		});
		presence.set(false);
		const before = host.pings;
		globalThis.dispatchEvent(new Event("keydown"));
		await Bun.sleep(150);
		expect(host.pings - before).toBe(0);
		presence.set(true);
		await eventually(() => expect(host.pings - before).toBe(1));
		await eventually(() =>
			expect(host.pings - before).toBeGreaterThanOrEqual(3),
		);
	});

	test("pageshow and resume bring an away page back", async () => {
		await open({ intervalMs: 30, staleMs: 30, timeoutMs: 1_000, activeMs: 50 });
		for (const signal of [
			() => globalThis.dispatchEvent(new Event("pageshow")),
			() => page.dispatchEvent(new Event("resume")),
		]) {
			await Bun.sleep(80);
			const before = host.pings;
			signal();
			await eventually(() => expect(host.pings - before).toBe(1));
		}
	});

	test("a suspended process checks its sockets when it resumes, even away", async () => {
		const { presence } = await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 1_000,
		});
		presence.set(false);
		await Bun.sleep(60);
		const before = host.pings;
		const now = Date.now;
		// Timers did not run for a minute: the device slept or the app was in the background.
		Date.now = () => now() + 60_000;
		try {
			await eventually(() => expect(host.pings - before).toBe(1));
			await Bun.sleep(100);
			expect(host.pings - before).toBe(1);
		} finally {
			Date.now = now;
		}
	});
	test("a window without focus counts as away sooner, even if its page claims to be visible", async () => {
		// A minimized WebView2 window: still "visible", but it lost focus.
		await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 1_000,
			activeMs: 60_000,
			unfocusedMs: 80,
		});
		globalThis.dispatchEvent(new Event("blur"));
		await Bun.sleep(100);
		const before = host.pings;
		await Bun.sleep(150);
		expect(host.pings - before).toBe(0);
		globalThis.dispatchEvent(new Event("focus"));
		await eventually(() => expect(host.pings - before).toBe(1));
		await eventually(() =>
			expect(host.pings - before).toBeGreaterThanOrEqual(3),
		);
	});
});

describe("connection events", () => {
	type Recorded = { event: string; root: string; args: unknown[] };
	/** Every connection of the connector, reconnections included. */
	function record(cloud: ReturnType<typeof createCloudConnector>) {
		const events: Recorded[] = [];
		cleanup.push(
			cloud.onConnection((connection) => {
				// A new connection is reported already in its current state.
				events.push({
					event: "new",
					root: connection.root,
					args: [connection.state],
				});
				for (const event of [
					"state",
					"server",
					"ping",
					"pong",
					"timeout",
					"suspended",
				] as const)
					connection.on(event, (...args: unknown[]) =>
						events.push({ event, root: connection.root, args }),
					);
			}),
		);
		return events;
	}
	const firsts = (events: Recorded[], event: string) =>
		events.filter((e) => e.event === event).map((e) => e.args[0]);

	test("each connection reports its server, state, pings, pongs and timeout", async () => {
		const { cloud, workspace, note } = await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 40,
		});
		const events = record(cloud);
		const [connection] = cloud.connections;
		expect(connection!.root).toBe(workspace.id);
		expect(connection!.state).toBe("open");
		expect(connection!.server).toEqual({
			backend: "test",
			id: host.instance,
			location: "local",
		});
		expect([...connection!.documents].sort()).toEqual(
			[workspace.id, note.id].sort(),
		);
		await eventually(() =>
			expect(firsts(events, "ping")).toContain("interval"),
		);
		await eventually(() =>
			expect(firsts(events, "pong").length).toBeGreaterThan(0),
		);
		expect(connection!.latencyMs).toBeGreaterThanOrEqual(0);

		host.freeze();
		await eventually(() => expect(firsts(events, "timeout")).toHaveLength(1));
		expect(connection!.state).toBe("closed");
		expect(connection!.error).toMatchObject({ code: "CONNECTION_FAILED" });
		host.thaw();
		await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
		// The reconnection is a new connection, to the same server.
		expect(
			events
				.filter((e) => e.event === "state" || e.event === "new")
				.map((e) => `${e.event}:${e.args[0]}`),
		).toEqual(["new:open", "state:closed", "new:connecting", "state:open"]);
		expect(firsts(events, "server")).toEqual([connection!.server]);
		expect(cloud.connections).toHaveLength(1);
		expect(cloud.connections[0]).not.toBe(connection);
	});

	test("every ping says why: send, network, return", async () => {
		const { cloud, presence, note } = await open({
			intervalMs: false,
			staleMs: 30,
			timeoutMs: 1_000,
		});
		const events = record(cloud);
		await Bun.sleep(40);
		note.title = "Lazy";
		await eventually(() => expect(firsts(events, "ping")).toEqual(["send"]));
		// One ping in flight per socket: wait for its answer before the next.
		await eventually(() => expect(firsts(events, "pong")).toHaveLength(1));
		setOnlineMode(true);
		await eventually(() =>
			expect(firsts(events, "ping")).toEqual(["send", "network"]),
		);
		await eventually(() => expect(firsts(events, "pong")).toHaveLength(2));
		await Bun.sleep(40);
		presence.set(true);
		await eventually(() =>
			expect(firsts(events, "ping")).toEqual(["send", "network", "return"]),
		);
	});

	test("a suspension is reported with its length", async () => {
		const { cloud } = await open({
			intervalMs: 30,
			staleMs: 30,
			timeoutMs: 1_000,
		});
		const events = record(cloud);
		const now = Date.now;
		Date.now = () => now() + 60_000;
		try {
			await eventually(() =>
				expect(firsts(events, "suspended")).toHaveLength(1),
			);
			expect(firsts(events, "suspended")[0]).toBeGreaterThanOrEqual(60_000);
			await eventually(() =>
				expect(firsts(events, "ping")).toContain("resume"),
			);
		} finally {
			Date.now = now;
		}
	});

	test("connections to several roots are reported separately", async () => {
		const a = await open({ intervalMs: false, staleMs: 30, timeoutMs: 1_000 });
		const roots: string[] = [];
		cleanup.push(
			a.cloud.onConnection((connection) => roots.push(connection.root)),
		);
		expect(roots).toEqual([a.workspace.id]);
		const other = `heartbeat-${crypto.randomUUID().slice(0, 8)}`;
		await createCloudClient({
			url: host.url,
			credential: secrets.apiKey,
		}).grant({
			subject: "alice",
			prefix: other,
			role: "owner",
		});
		const second = createPulse(
			Workspace,
			{ id: other, name: "Other", notes: [] },
			{ scope: createPulseScope(), connectors: [a.cloud], reconnect },
		);
		cleanup.push(() => destroyPulse(second));
		await connectPulse(second).synced;
		expect(roots).toEqual([a.workspace.id, other]);
		expect(a.cloud.connections.map((c) => c.root).sort()).toEqual(
			[a.workspace.id, other].sort(),
		);
	});
});

describe("presence", () => {
	class Page extends EventTarget {
		visibilityState: "visible" | "hidden" = "visible";
		hasFocus() {
			return true;
		}
		show(state: "visible" | "hidden") {
			this.visibilityState = state;
			this.dispatchEvent(new Event("visibilitychange"));
		}
	}
	let page: Page;
	beforeEach(() => {
		page = new Page();
		Object.assign(globalThis, { document: page });
	});
	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	test("changes are reported with their reason, independently of any connection", () => {
		const presence = createPresence({ activeMs: 60_000, unfocusedMs: 60 });
		cleanup.push(() => presence.dispose());
		const changes: string[] = [];
		cleanup.push(
			presence.on("change", (p) =>
				changes.push(
					`${p.reason}:${p.present ? "present" : "away"}${p.focused ? "" : ",unfocused"}${p.visible ? "" : ",hidden"}${p.away ? ",native" : ""}`,
				),
			),
		);
		expect(changes).toEqual(["start:present"]);
		globalThis.dispatchEvent(new Event("blur"));
		return eventually(() =>
			expect(changes.at(-1)).toBe("idle:away,unfocused"),
		).then(() => {
			let returns = 0;
			cleanup.push(presence.on("return", () => returns++));
			globalThis.dispatchEvent(new Event("focus"));
			page.show("hidden");
			page.show("visible");
			presence.set(false);
			presence.set(true);
			// Repeated input while present changes nothing.
			globalThis.dispatchEvent(new Event("keydown"));
			globalThis.dispatchEvent(new Event("keydown"));
			expect(changes).toEqual([
				"start:present",
				"blur:present,unfocused",
				"idle:away,unfocused",
				"focus:present",
				"hidden:away,hidden",
				"visible:present",
				"native:away,native",
				"native:present",
			]);
			expect(returns).toBe(3);
			expect(presence.state).toMatchObject({
				present: true,
				focused: true,
				visible: true,
				away: false,
				reason: "native",
			});
			// A late listener starts from the current state.
			const late: boolean[] = [];
			cleanup.push(presence.on("change", (p) => late.push(p.present)));
			expect(late).toEqual([true]);
		});
	});

	test("several connectors share one presence", async () => {
		const shared = createPresence();
		cleanup.push(() => shared.dispose());
		const a = await open({ intervalMs: false, staleMs: 30, timeoutMs: 1_000 });
		const b = createCloudConnector({
			url: host.url,
			token: () => signCloudToken({ subject: "alice" }, secrets.tokenSecret),
			presence: shared,
		});
		cleanup.push(() => b.close());
		expect(a.presence).not.toBe(shared);
		expect(shared.state.present).toBe(true);
	});
});
