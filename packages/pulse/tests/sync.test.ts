import { describe, expect, test } from "bun:test";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	snapshotPulse,
	subscribePulse,
	type Connector,
	type PulseProperties,
} from "../source/index";
import { Document, data, options, eventually } from "./helpers";

function setup() {
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
	return { relay, connector };
}
describe("synchronization", () => {
	test("creation, loading, retained references and continuous updates", async () => {
		const { relay, connector } = setup();
		const a = createPulse(Document, data(), {
			...options(),
			connectors: [connector],
		});
		const task = connectPulse(a);
		expect(connectPulse(a)).toBe(task);
		expect(await task.synced).toBe(a);
		const b = await loadPulse(Document, a.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		const nested = b.nested;
		const items = b.items;
		const item = b.items[0]!;
		let notifications = 0;
		subscribePulse(b, () => notifications++);
		a.nested.count = 42;
		a.items[0]!.value = 17;
		a.items.push({ value: 3 });
		await eventually(() => expect(snapshotPulse(a)).toEqual(snapshotPulse(b)));
		expect(nested.count).toBe(42);
		expect(items.length).toBe(3);
		expect(item.value).toBe(17);
		expect(notifications).toBeGreaterThan(1);
		const size = relay.getLog(a.id)!.size;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(relay.getLog(a.id)!.size).toBe(size);
		destroyPulse(a);
		destroyPulse(b);
		expect(relay.peerCount).toBe(0);
	});
	test("offline concurrent edits converge on reconnect", async () => {
		const { connector } = setup();
		const a = createPulse(Document, data(), {
			...options(),
			connectors: [connector],
		});
		await connectPulse(a).synced;
		const b = await loadPulse(Document, a.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(a);
		disconnectPulse(b);
		a.nested.count = 11;
		a.items.push({ value: 8 });
		b.title = "Offline";
		b.items.unshift({ value: 9 });
		await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
		await eventually(() => expect(snapshotPulse(a)).toEqual(snapshotPulse(b)));
		expect(a.title).toBe("Offline");
		expect(a.nested.count).toBe(11);
		expect(a.items.map((item) => item.value)).toContain(8);
		expect(a.items.map((item) => item.value)).toContain(9);
		destroyPulse(a);
		destroyPulse(b);
	});
	test("a local connector relays remote updates into a second connector", async () => {
		const localRelay = new PulseRelay();
		const remoteRelay = new PulseRelay();
		const local = createMemoryConnector(localRelay);
		const remote = createMemoryConnector(remoteRelay, "remote");
		const a = createPulse(Document, data(), {
			...options(),
			connectors: [local, remote],
		});
		await connectPulse(a).synced;
		const b = await loadPulse(Document, a.id, {
			...options(),
			connectors: [remote],
			waitFor: "all",
		});
		b.nested.count = 91;
		await eventually(() => expect(a.nested.count).toBe(91));
		await eventually(() =>
			expect(localRelay.getLog(a.id)!.vector).toEqual(
				remoteRelay.getLog(a.id)!.vector,
			),
		);
		destroyPulse(a);
		destroyPulse(b);
	});
	test("no connector, missing documents, timeouts and cancellation always settle", async () => {
		const a = createPulse(Document, data(), options());
		expect(await connectPulse(a).synced).toBe(a);
		await expect(
			loadPulse(Document, "missing", options()),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const silent: Connector = {
			kind: "remote",
			async open() {
				return { close() {}, async send() {} };
			},
		};
		await expect(
			loadPulse(Document, "silent", {
				...options(),
				connectors: [silent],
				timeoutMs: 15,
				waitFor: "all",
			}),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		const abort = new AbortController();
		abort.abort();
		await expect(
			loadPulse(Document, "abort", {
				...options(),
				connectors: [silent],
				signal: abort.signal,
			}),
		).rejects.toMatchObject({ code: "CLOSED" });
		const never: Connector = {
			kind: "remote",
			open() {
				return new Promise(() => {});
			},
		};
		await expect(
			loadPulse(Document, "never", {
				...options(),
				connectors: [never],
				timeoutMs: 15,
			}),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		destroyPulse(a);
	});
	test("ready can resolve before a remote connector; destruction cancels pending work", async () => {
		const { connector } = setup();
		const seed = createPulse(Document, data(), {
			...options(),
			connectors: [connector],
		});
		await connectPulse(seed).synced;
		const silent: Connector = {
			kind: "remote",
			async open() {
				return { close() {}, async send() {} };
			},
		};
		const scope = createPulseScope();
		const loaded = await loadPulse(Document, seed.id, {
			scope,
			connectors: [connector, silent],
		});
		const synced = getPulseMeta(loaded).connecting!.synced;
		destroyPulse(loaded);
		await expect(synced).rejects.toMatchObject({ code: "CLOSED" });
		destroyPulse(seed);
	});
	test("migrations load old documents and persist the latest storage shape", async () => {
		type V1 = PulseProperties<"User"> & { name: string; email: string };
		type V2 = PulseProperties<"User"> & { name: string; emailV2: string };
		const Old = definePulse<V1>("User").materialize();
		const New = definePulse<V1>("User")
			.migrate<V2>((before) => ({ emailV2: before.email }))
			.materialize<V1>(({ bind }) => ({ email: bind("emailV2") }));
		const { connector } = setup();
		const old = createPulse(
			Old,
			{ name: "Ada", email: "ada@example.com" },
			{ ...options(), connectors: [connector] },
		);
		await connectPulse(old).synced;
		disconnectPulse(old);
		const latest = await loadPulse(New, old.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(latest.version).toBe(2);
		expect(latest.email).toBe("ada@example.com");
		expect(Object.keys(latest)).toContain("email");
		expect(Object.keys(latest)).not.toContain("emailV2");
		latest.email = "new@example.com";
		expect((getPulseMeta(latest).model.view() as any).emailV2).toBe(
			"new@example.com",
		);
		const scope = getPulseMeta(latest).options.scope;
		expect(
			createPulse(
				New,
				{ id: latest.id, name: "ignored", emailV2: "ignored" },
				{ scope },
			),
		).toBe(latest);
		await getPulseMeta(latest).connections[0]!.syncBack();
		destroyPulse(latest);
		const again = await loadPulse(New, old.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(again.email).toBe("new@example.com");
		destroyPulse(again);
		destroyPulse(old);
	});
	test("a newer incompatible document does not poison the identity map", async () => {
		const { connector } = setup();
		const seed = createPulse(Document, data(), {
			...options(),
			connectors: [connector],
		});
		await connectPulse(seed).synced;
		const Other = definePulse<PulseProperties<"Other">>("Other").materialize();
		const scope = createPulseScope();
		await expect(
			loadPulse(Other, seed.id, {
				scope,
				connectors: [connector],
				waitFor: "all",
			}),
		).rejects.toBeDefined();
		expect(scope.pulses.size).toBe(0);
		destroyPulse(seed);
	});
});

test("waitFor a selected connector does not wait for a silent unrelated connector", async () => {
	const connector = createMemoryConnector();
	const seed = createPulse(Document, data(), {
		...options(),
		connectors: [connector],
	});
	await connectPulse(seed).synced;
	const silent: Connector = {
		kind: "remote",
		async open() {
			return { close() {}, async send() {} };
		},
	};
	const loaded = await loadPulse(Document, seed.id, {
		...options(),
		connectors: [connector, silent],
		waitFor: [connector],
		timeoutMs: 100,
	});
	expect(loaded.title).toBe(seed.title);
	expect(getPulseMeta(loaded).connections[0]!.status).toBe("synced");
	destroyPulse(loaded);
	destroyPulse(seed);
});

test("histories larger than one frame upload and download in complete pages", async () => {
	const connector = createMemoryConnector();
	const seed = createPulse(Document, data(), {
		...options(),
		connectors: [connector],
	});
	// Sequence edits always keep their history, unlike a rewritten field.
	for (let i = 0; i < 4200; i++) seed.items.push({ value: i });
	await connectPulse(seed).synced;
	const loaded = await loadPulse(Document, seed.id, {
		...options(),
		connectors: [connector],
		waitFor: "all",
	});
	expect(loaded.items.length).toBe(4200 + seed.items.length - 4200);
	expect(loaded.items.at(-1)).toEqual({ value: 4199 });
	expect(getPulseMeta(loaded).log.size).toBe(4201);
	expect(getPulseMeta(loaded).log.pendingCount).toBe(0);
	destroyPulse(loaded);
	destroyPulse(seed);
});

test("relay broadcast survives a throwing middle peer without sending an error to the sender", async () => {
	const { decodeMessage, encodeMessage } =
		await import("../source/connection/PulseMessage");
	const { patchToRow } = await import("../source/connection/PulsePatch");
	const { CorePatch } = await import("../source/core/operations");
	const { prepareValue } = await import("../source/core/values");

	const relay = new PulseRelay();
	const docId = "broadcast-fault";
	const senderFrames: ReturnType<typeof decodeMessage>[] = [];
	const firstFrames: ReturnType<typeof decodeMessage>[] = [];
	const lastFrames: ReturnType<typeof decodeMessage>[] = [];
	let middleSawConnect = false;

	const sender = relay.open((b) => senderFrames.push(decodeMessage(b)));
	const first = relay.open((b) => firstFrames.push(decodeMessage(b)));
	const middle = relay.open(() => {
		if (middleSawConnect) throw new Error("socket closed");
		middleSawConnect = true;
	});
	const last = relay.open((b) => lastFrames.push(decodeMessage(b)));

	const connect = encodeMessage({ kind: 1, docId, requestId: 1, vv: [] });
	for (const p of [sender, first, middle, last]) p.receive(connect);
	senderFrames.length = 0;
	firstFrames.length = 0;
	lastFrames.length = 0;

	const row = patchToRow(
		docId,
		new CorePatch(65536, 1, 1, "", [{ kind: 0, value: prepareValue("ok") }]),
		[],
	);
	sender.receive(
		encodeMessage({ kind: 4, docId, requestId: 2, vv: [], rows: [row] }),
	);

	// Sender gets only its ack, never a follow-up error frame.
	expect(senderFrames).toEqual([
		{ kind: 5, docId, requestId: 2, vv: [[65536, 2]] },
	]);
	// Both peers before and after the throwing peer receive the update.
	expect(firstFrames).toHaveLength(1);
	expect(firstFrames[0]!.kind).toBe(4);
	expect(lastFrames).toHaveLength(1);
	expect(lastFrames[0]!.kind).toBe(4);
	for (const p of [sender, first, middle, last]) p.close();
});

test("relay broadcast encodes once per protocol version", async () => {
	const { encodeMessage } = await import("../source/connection/PulseMessage");
	const { patchToRow } = await import("../source/connection/PulsePatch");
	const { CorePatch } = await import("../source/core/operations");
	const { prepareValue } = await import("../source/core/values");

	const docId = "broadcast-scale";
	const makeRow = (clock: number, sid = 65536) =>
		patchToRow(
			docId,
			new CorePatch(sid, clock, clock, "", [
				{ kind: 0, value: prepareValue("x".repeat(64)) },
			]),
			clock > 1 ? [[sid, clock]] : [],
		);

	const run = (peerCount: number) => {
		const relay = new PulseRelay();
		const receivedV1: Uint8Array[] = [];
		const receivedV3: Uint8Array[] = [];
		const peers = [];
		const connect = encodeMessage({ kind: 1, docId, requestId: 1, vv: [] });
		const sender = relay.open(() => {}, { protocolVersion: 3 });
		sender.receive(connect);
		peers.push(sender);
		for (let i = 0; i < peerCount; i++) {
			const version = i % 2 === 0 ? (3 as const) : (1 as const);
			const bucket = version === 3 ? receivedV3 : receivedV1;
			const p = relay.open(
				(bytes) => {
					if (bytes[2] === 4 || bytes[0] === 2) bucket.push(bytes);
				},
				{ protocolVersion: version },
			);
			p.receive(connect);
			peers.push(p);
		}
		const frames: Uint8Array[] = [];
		let clock = 1;
		for (let r = 0; r < 15; r++) {
			const rows = Array.from({ length: 40 }, () => makeRow(clock++));
			frames.push(
				encodeMessage(
					{ kind: 4, docId, requestId: 10 + r, vv: [], rows },
					{ peerVersion: 3 },
				),
			);
		}
		for (const frame of frames) sender.receive(frame);
		for (const p of peers) p.close();
		// Peers sharing a protocol version receive the same encoded buffer.
		expect(receivedV1.length).toBe((peerCount / 2) * 15);
		expect(receivedV3.length).toBe((peerCount / 2) * 15);
		expect(receivedV1[0]).toBe(receivedV1[1]);
		expect(receivedV3[0]).toBe(receivedV3[1]);
	};

	// The shared buffers above are the guard: a timing ratio would be flaky.
	run(100);
});
