import { afterEach, describe, expect, test } from "bun:test";
import {
	array,
	connectPulse,
	createPulse,
	createPulseScope,
	decodeMessage,
	definePresence,
	definePulse,
	destroyPulse,
	encodeMessage,
	exportPulseUpdates,
	getPulseMeta,
	joinPresence,
	loadPulse,
	object,
	richText,
	sub,
	pulseRef,
	type PulseMessage,
} from "pulsify-core";
import {
	CLOUD_PING,
	CLOUD_PONG,
	CLOUD_SUBPROTOCOLS,
	CLOUD_TOKEN_SUBPROTOCOL,
	cloudPath,
	createCloudClient,
	createCloudConnector,
	signCloudToken,
	type CloudConnection,
	type CloudConnectorOptions,
} from "pulsify-cloud";

export type CloudBackend = { url: string; tokenSecret: string; apiKey: string };

export const Note = definePulse(
	"CloudNote",
	object({ title: "string", body: richText() }),
).materialize();
export const Workspace = definePulse(
	"CloudWorkspace",
	object({ name: "string", notes: array(sub(Note)) }),
).materialize();

export async function eventually(
	check: () => unknown,
	timeoutMs = 5_000,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() - start > timeoutMs) throw error;
			await Bun.sleep(20);
		}
	}
}

/**
 * The behavior every Pulsify Cloud backend must share: routing, tokens,
 * grants, one multiplexed socket per root, selective subscriptions and live
 * role changes. Runs against real sockets.
 */
export function describeCloudBackend(
	name: string,
	backend: () => CloudBackend,
): void {
	const unique = (label: string) =>
		`${label}-${crypto.randomUUID().slice(0, 8)}`;
	const sign = (subject: string) =>
		signCloudToken({ subject }, backend().tokenSecret, { expiresIn: "10m" });
	const admin = () =>
		createCloudClient({ url: backend().url, credential: backend().apiKey });
	const userApi = (subject: string) =>
		createCloudClient({ url: backend().url, credential: () => sign(subject) });
	const opened: { close(): void }[] = [];
	afterEach(() => {
		for (const item of opened.splice(0)) item.close();
	});
	const device = (
		subject: string,
		options: Partial<CloudConnectorOptions> = {},
	) => {
		const connector = createCloudConnector({
			url: backend().url,
			token: () => sign(subject),
			lingerMs: 100,
			...options,
		});
		opened.push(connector);
		const errors: Error[] = [];
		const scope = createPulseScope();
		return {
			connector,
			errors,
			options: {
				connectors: [connector],
				scope,
				timeoutMs: 5_000,
				onError: (error: Error) => errors.push(error),
			},
		};
	};
	const raw = async (
		root: string,
		subject: string | undefined,
		protocols: string[] = [CLOUD_SUBPROTOCOLS[2], CLOUD_SUBPROTOCOLS[1]],
		token?: string,
	) => {
		const credential = token ?? (subject ? await sign(subject) : undefined);
		const socket = new WebSocket(
			`${backend().url.replace(/^http/, "ws")}${cloudPath(root, "connect")}`,
			credential
				? [...protocols, CLOUD_TOKEN_SUBPROTOCOL + credential]
				: protocols,
		);
		opened.push(socket);
		socket.binaryType = "arraybuffer";
		const frames: PulseMessage[] = [];
		const texts: unknown[] = [];
		const welcomes: {
			server: Record<string, unknown>;
			presence?: boolean;
		}[] = [];
		/** The type of every message received, in order; `frame` for binary ones. */
		const order: string[] = [];
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return void order.push("frame");
			const message = JSON.parse(event.data);
			order.push(message.type);
			if (message.type === "welcome") welcomes.push(message);
			else if (message.type !== "pong") texts.push(message);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string")
				frames.push(decodeMessage(new Uint8Array(event.data)));
		});
		const closed = new Promise<CloseEvent>((resolve) =>
			socket.addEventListener("close", resolve),
		);
		const open = await new Promise<boolean>((resolve) => {
			socket.addEventListener("open", () => resolve(true));
			socket.addEventListener("error", () => resolve(false));
			socket.addEventListener("close", () => resolve(false));
		});
		return { socket, open, frames, texts, welcomes, order, closed };
	};
	/** Alice owns a root workspace with two rich-text notes, synced from device A. */
	const seed = async (label: string) => {
		const root = unique(label);
		await admin().grant({ subject: "alice", prefix: root, role: "owner" });
		const a = device("alice");
		const workspace = createPulse(
			Workspace,
			{ id: root, name: "Alice", notes: [] },
			a.options,
		);
		const first = createPulse(
			Note,
			{ title: "First", body: "Hello" },
			{ parent: workspace },
		);
		const second = createPulse(
			Note,
			{ title: "Second", body: "World" },
			{ parent: workspace },
		);
		workspace.notes.push(pulseRef(first), pulseRef(second));
		await Promise.all(
			[workspace, first, second].map((pulse) => connectPulse(pulse).synced),
		);
		return { root, a, workspace, first, second };
	};

	describe(`${name} cloud backend`, () => {
		test("serves health, rejects unknown routes and plain requests", async () => {
			const { url } = backend();
			expect(await (await fetch(`${url}/v1/health`)).json()).toEqual({
				ok: true,
			});
			const missing = await fetch(`${url}/v1/nothing`);
			expect(missing.status).toBe(404);
			expect(await missing.json()).toMatchObject({
				error: { code: "NOT_FOUND" },
			});
			const plain = await fetch(`${url}${cloudPath("root", "connect")}`);
			expect(plain.status).toBe(426);
			const preflight = await fetch(`${url}${cloudPath("root", "grants")}`, {
				method: "OPTIONS",
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		});

		test("authenticates sockets and checks rights per document", async () => {
			const root = unique("auth");
			await admin().grant({ subject: "alice", prefix: root, role: "reader" });
			expect((await raw(root, undefined)).open).toBe(false);
			expect((await raw(root, undefined, undefined, "junk")).open).toBe(false);
			const forged = await signCloudToken(
				{ subject: "alice" },
				"another secret that is long enough to sign",
			);
			expect((await raw(root, undefined, undefined, forged)).open).toBe(false);
			const mallory = await raw(root, "mallory");
			expect(mallory.open).toBe(true);
			mallory.socket.send(
				encodeMessage({ kind: 1, docId: root, requestId: 1, vv: [] }),
			);
			await eventually(() => expect(mallory.frames).toHaveLength(1));
			expect(mallory.frames[0]).toMatchObject({ kind: 6, code: "FORBIDDEN" });
			expect(mallory.texts).toEqual([
				{ type: "role", docId: root, role: null },
			]);
			const alice = await raw(root, "alice");
			expect(alice.open).toBe(true);
			expect(alice.socket.protocol).toBe(CLOUD_SUBPROTOCOLS[2]);
			const legacy = await raw(root, "alice", [CLOUD_SUBPROTOCOLS[1]]);
			expect(legacy.socket.protocol).toBe(CLOUD_SUBPROTOCOLS[1]);
			expect((await raw(root, "alice", ["chat"])).open).toBe(false);
		});

		test("manages grants with the API key and lets owners share their subtree", async () => {
			const root = unique("grants");
			const other = unique("other");
			const api = admin();
			expect(
				await api.grant({ subject: "alice", prefix: root, role: "owner" }),
			).toEqual({ subject: "alice", prefix: root, role: "owner" });
			await api.grant({ subject: "dave", prefix: other, role: "owner" });
			for (const invalid of [
				{ subject: "bob", prefix: `${other}/x`, role: "reader" },
				{ subject: "bob", prefix: `${root}/x`, role: "admin" },
				{ subject: "", prefix: root, role: "reader" },
			])
				await expect(
					fetch(`${backend().url}${cloudPath(root, "grants")}`, {
						method: "PUT",
						headers: { Authorization: `Bearer ${backend().apiKey}` },
						body: JSON.stringify(invalid),
					}).then((response) => response.status),
				).resolves.toBe(400);
			const anonymous = await fetch(
				`${backend().url}${cloudPath(root, "grants")}`,
			);
			expect(anonymous.status).toBe(401);
			await expect(
				createCloudClient({ url: backend().url, credential: "junk" }).grants(
					root,
				),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });

			const alice = userApi("alice");
			const bob = userApi("bob");
			await expect(
				bob.grant({ subject: "bob", prefix: root, role: "owner" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await alice.grant({
				subject: "bob",
				prefix: `${root}/notes`,
				role: "reader",
			});
			await alice.grant({
				subject: "*",
				prefix: `${root}/public`,
				role: "reader",
			});
			await expect(
				alice.grant({ subject: "bob", prefix: other, role: "reader" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await alice.grants(root)).toEqual([
				{ subject: "alice", prefix: root, role: "owner" },
				{ subject: "bob", prefix: `${root}/notes`, role: "reader" },
				{ subject: "*", prefix: `${root}/public`, role: "reader" },
			]);
			expect(await bob.grants(root)).toEqual([
				{ subject: "bob", prefix: `${root}/notes`, role: "reader" },
			]);
			expect(await api.grants(root, { subject: "bob" })).toHaveLength(1);
			expect(await api.grants(root, { prefix: `${root}/public` })).toHaveLength(
				1,
			);
			expect(
				await alice.revoke({ subject: "bob", prefix: `${root}/notes` }),
			).toBe(true);
			expect(
				await alice.revoke({ subject: "bob", prefix: `${root}/notes` }),
			).toBe(false);
			await expect(alice.usage(root)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(await api.usage(root)).toMatchObject({
				root,
				documents: 0,
				rows: 0,
				bytes: 0,
			});
		});

		test("multiplexes a root and its sub-documents over one socket", async () => {
			const { root, a, first, second } = await seed("tree");
			expect(a.connector.connections).toHaveLength(1);
			expect([...a.connector.connections[0]!.documents].sort()).toEqual(
				[root, first.id, second.id].sort(),
			);
			expect(a.connector.connections[0]!.envelope).toBe(2);

			const b = device("alice");
			const workspace = await loadPulse(Workspace, root, {
				...b.options,
			});
			const [bFirst, bSecond] = workspace.notes.map((note) => note.pulse!);
			expect(bFirst!.title).toBe("First");
			expect(String(bSecond!.body)).toBe("World");
			expect(b.connector.connections).toHaveLength(1);
			expect(b.connector.connections[0]!.documents).toHaveLength(3);
			expect(b.connector.roleOf(root)).toBe("owner");

			first.body.insert(5, " there");
			await eventually(() => expect(String(bFirst!.body)).toBe("Hello there"));
			bSecond!.title = "Second, from B";
			await eventually(() => expect(second.title).toBe("Second, from B"));

			const usage = await admin().usage(root);
			expect(usage.documents).toBe(3);
			expect(usage.rows).toBeGreaterThan(0);
			expect(usage.connections).toBe(2);
		});

		test("subscribes to the documents a client loads, and only those", async () => {
			const { root, workspace, first, second } = await seed("select");
			const c = device("alice");
			const note = await loadPulse(Note, first.id, c.options);
			expect(c.connector.connections[0]!.documents).toEqual([first.id]);

			const probe = await raw(root, "alice");
			probe.socket.send(
				encodeMessage({ kind: 1, docId: first.id, requestId: 1, vv: [] }),
			);
			await eventually(() =>
				expect(probe.frames.some((frame) => frame.kind === 2)).toBe(true),
			);
			expect(probe.texts).toContainEqual({
				type: "role",
				docId: first.id,
				role: "owner",
			});
			const received = () =>
				probe.frames
					.filter((frame) => frame.kind === 4)
					.map((frame) => frame.docId);

			second.title = "Not for the probe";
			workspace.name = "Not for the probe either";
			first.title = "For the probe";
			await eventually(() => expect(note.title).toBe("For the probe"));
			await eventually(() => expect(received()).toEqual([first.id]));

			probe.socket.send(
				JSON.stringify({ type: "unsubscribe", docId: first.id }),
			);
			probe.socket.send(
				encodeMessage({
					kind: 1,
					docId: `${root}/barrier`,
					requestId: 2,
					vv: [],
				}),
			);
			await eventually(() =>
				expect(probe.frames.some((frame) => frame.requestId === 2)).toBe(true),
			);
			first.title = "After unsubscribing";
			await eventually(() => expect(note.title).toBe("After unsubscribing"));
			await Bun.sleep(50);
			expect(received()).toEqual([first.id]);

			destroyPulse(note);
			await eventually(() => expect(c.connector.connections).toHaveLength(0));
		});

		test("enforces reader roles and applies grant changes to live sessions", async () => {
			const { root, first, workspace } = await seed("roles");
			await admin().grant({ subject: "bob", prefix: first.id, role: "reader" });
			const b = device("bob");
			const roles: [string, string | null][] = [];
			b.connector.onRole((docId, role) => roles.push([docId, role]));
			const note = await loadPulse(Note, first.id, b.options);
			expect(note.title).toBe("First");
			expect(b.connector.roleOf(first.id)).toBe("reader");
			await expect(loadPulse(Workspace, root, b.options)).rejects.toMatchObject(
				{
					code: "FORBIDDEN",
				},
			);
			expect(b.connector.roleOf(root)).toBeNull();

			await admin().grant({ subject: "bob", prefix: first.id, role: "editor" });
			await eventually(() =>
				expect(b.connector.roleOf(first.id)).toBe("editor"),
			);
			note.title = "Edited by Bob";
			await eventually(() => expect(first.title).toBe("Edited by Bob"));

			b.errors.length = 0;
			await admin().revoke({ subject: "bob", prefix: first.id });
			await eventually(() => expect(b.connector.roleOf(first.id)).toBeNull());
			await eventually(() => expect(getPulseMeta(note).status).toBe("error"));
			expect(
				b.errors.map((error) => (error as { code?: string }).code),
			).toContain("FORBIDDEN");
			expect(roles).toEqual([
				[first.id, "reader"],
				[root, null],
				[first.id, "editor"],
				[first.id, null],
			]);

			await admin().grant({ subject: "*", prefix: root, role: "reader" });
			const c = device("carol");
			const readOnly = await loadPulse(Workspace, root, c.options);
			readOnly.name = "Carol was here";
			await eventually(() =>
				expect(
					c.errors.map((error) => (error as { code?: string }).code),
				).toContain("FORBIDDEN"),
			);
			await Bun.sleep(50);
			expect(workspace.name).toBe("Alice");
		});

		test("relays presence between the sessions of a document and announces departures", async () => {
			const { root, first, second, workspace } = await seed("presence");
			await admin().grant({ subject: "bob", prefix: first.id, role: "reader" });
			const Viewer = definePresence("viewer", object({ name: "string" }), {
				throttleMs: 0,
			});
			const names = (presence: { others: readonly any[] }) =>
				presence.others
					.map((other) => [other.subject, other.state.name])
					.sort();
			// A client that never used presence must not receive its frames.
			const old = await raw(root, "alice");
			await eventually(() => expect(old.welcomes).toHaveLength(1));
			// Presence is a capability a backend announces in its welcome.
			if (!old.welcomes[0]!.presence) return;
			old.socket.send(
				encodeMessage({ kind: 1, docId: first.id, requestId: 1, vv: [] }),
			);
			await eventually(() => expect(old.frames).toHaveLength(1));

			const b = device("bob");
			const note = await loadPulse(Note, first.id, b.options);
			const alice = joinPresence(first, Viewer);
			const bob = joinPresence(note, Viewer);
			alice.set({ name: "Alice" });
			// A reader publishes too, and its subject comes from its token.
			bob.set({ name: "I am Alice" });
			await eventually(() => {
				expect(names(bob)).toEqual([["alice", "Alice"]]);
				expect(names(alice)).toEqual([["bob", "I am Alice"]]);
			});
			expect(alice.others[0]!.peer).not.toBe(bob.others[0]!.peer);

			// Presence belongs to one document: other documents see nothing.
			const elsewhere = joinPresence(second, Viewer);
			const onRoot = joinPresence(workspace, Viewer);
			onRoot.set({ name: "On the workspace" });
			await Bun.sleep(50);
			expect(elsewhere.others).toEqual([]);
			expect(names(bob)).toEqual([["alice", "Alice"]]);

			// A session that arrives later receives the current states.
			const c = device("alice");
			const late = joinPresence(
				await loadPulse(Note, first.id, c.options),
				Viewer,
			);
			await eventually(() =>
				expect(names(late)).toEqual([
					["alice", "Alice"],
					["bob", "I am Alice"],
				]),
			);

			// Leaving a document, without closing the socket, is announced.
			destroyPulse(note);
			await eventually(() => expect(alice.others).toEqual([]));

			// So is losing access to it.
			const again = await loadPulse(Note, first.id, {
				...b.options,
				scope: createPulseScope(),
			});
			joinPresence(again, Viewer).set({ name: "Bob" });
			await eventually(() => expect(names(alice)).toEqual([["bob", "Bob"]]));
			await admin().revoke({ subject: "bob", prefix: first.id });
			await eventually(() => expect(alice.others).toEqual([]));

			expect(old.order.filter((kind) => kind === "frame")).toHaveLength(
				old.frames.length,
			);
		});

		test("every socket starts with a welcome naming its server", async () => {
			const root = unique("welcome");
			await admin().grant({ subject: "alice", prefix: root, role: "owner" });
			const first = await raw(root, "alice");
			await eventually(() => expect(first.welcomes).toHaveLength(1));
			const { server } = first.welcomes[0]!;
			expect(typeof server["backend"]).toBe("string");
			expect(typeof server["id"]).toBe("string");
			expect(server["id"]).not.toBe("");
			first.socket.send(
				encodeMessage({ kind: 1, docId: root, requestId: 1, vv: [] }),
			);
			await eventually(() => expect(first.frames).toHaveLength(1));
			expect(first.order).toEqual(["welcome", "role", "frame"]);
			// The same root is served by the same Durable Object or machine.
			const second = await raw(root, "alice");
			await eventually(() => expect(second.welcomes).toHaveLength(1));
			expect(second.welcomes[0]!.server).toEqual(server);

			const d = device("alice");
			const connections: CloudConnection[] = [];
			d.connector.onConnection((connection) => connections.push(connection));
			await loadPulse(Workspace, root, d.options).catch(() => {});
			expect(connections).toHaveLength(1);
			await eventually(() =>
				expect(connections[0]!.server).toEqual(server as never),
			);
		});

		test("answers a socket ping with a pong, without touching subscriptions", async () => {
			const root = unique("ping");
			await admin().grant({ subject: "alice", prefix: root, role: "owner" });
			const probe = await raw(root, "alice");
			const texts: string[] = [];
			probe.socket.addEventListener("message", (event) => {
				if (event.data === CLOUD_PONG) texts.push(event.data);
			});
			for (let i = 0; i < 3; i++) probe.socket.send(CLOUD_PING);
			await eventually(() =>
				expect(texts).toEqual([CLOUD_PONG, CLOUD_PONG, CLOUD_PONG]),
			);
			probe.socket.send(
				encodeMessage({ kind: 1, docId: root, requestId: 1, vv: [] }),
			);
			await eventually(() => expect(probe.frames).toHaveLength(1));
			expect(probe.frames[0]).toMatchObject({ kind: 2, found: false });
		});

		test("refuses frames outside the root, uploads before connect and garbage", async () => {
			const root = unique("violations");
			await admin().grant({ subject: "alice", prefix: root, role: "owner" });
			const probe = await raw(root, "alice");
			probe.socket.send(
				encodeMessage({
					kind: 1,
					docId: "elsewhere/doc",
					requestId: 7,
					vv: [],
				}),
			);
			const local = createPulse(
				Note,
				{ id: `${root}/local`, title: "Local", body: "" },
				{ scope: createPulseScope() },
			);
			const [upload] = exportPulseUpdates(local, [], { kind: 3, requestId: 8 });
			probe.socket.send(upload as Uint8Array<ArrayBuffer>);
			await eventually(() => expect(probe.frames).toHaveLength(2));
			expect(probe.frames).toMatchObject([
				{ kind: 6, requestId: 7, code: "FORBIDDEN" },
				{ kind: 6, requestId: 8, code: "INVALID_MESSAGE" },
			]);
			probe.socket.send("not json");
			expect((await probe.closed).code).toBe(1008);
		});

		test("keeps one socket per root and connector, with envelope 1 on request", async () => {
			const { root, first } = await seed("sockets");
			const second = unique("second");
			await admin().grant({ subject: "alice", prefix: second, role: "owner" });
			const d = device("alice", { envelope: 1 });
			await loadPulse(Workspace, root, d.options);
			const other = createPulse(
				Workspace,
				{ id: second, name: "Second root", notes: [] },
				d.options,
			);
			await connectPulse(other).synced;
			expect(
				d.connector.connections
					.map((socket) => [socket.root, socket.envelope])
					.sort(),
			).toEqual(
				[
					[root, 1 as const],
					[second, 1 as const],
				].sort(),
			);
			// A second scope loading the same document gets its own socket.
			await loadPulse(Note, first.id, {
				...d.options,
				scope: createPulseScope(),
			});
			expect(
				d.connector.connections.filter(
					(connection) => connection.root === root,
				),
			).toHaveLength(2);
		});
	});
}
