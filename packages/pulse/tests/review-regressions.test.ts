import { expect, test } from "bun:test";
import { array, tuple } from "@gin-quin/codec";
import {
	connectPulse,
	arrayOperations,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	PulseRelay,
	snapshotPulse,
	subscribePulse,
	loadPulse,
	type ConnectPulseResolvers,
	type Pulse,
	type PulseProperties,
} from "../source/index";
import { wireCodec } from "../source/protocol/wireCodec";
import { chunkRows } from "../source/protocol/chunkRows";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage";
import { Document, data, options } from "./helpers";

test("object keys cannot lose their identity during UTF-8 encoding", () => {
	const config = options();
	expect(() =>
		createPulse(
			Document,
			{ ...data(), nested: { ["\ud800"]: 1, "�": 2 } } as any,
			config,
		),
	).toThrow("Unsupported property");
	expect(config.scope.pulses.size).toBe(0);
	const pulse = createPulse(Document, data(), config);
	try {
		const before = snapshotPulse(pulse);
		const vector = getPulseMeta(pulse).log.vector;
		expect(() => {
			(pulse.nested as any)["\ud800"] = 1;
		}).toThrow("Unsupported property");
		expect(snapshotPulse(pulse)).toEqual(before);
		expect(getPulseMeta(pulse).log.vector).toEqual(vector);
	} finally {
		destroyPulse(pulse);
	}
});

test("codec handles collections without a second schema traversal or node budget", () => {
	const codec = wireCodec(tuple(array(tuple("uint", "uint")), "uint"));
	const pairs: [number, number][] = Array.from({ length: 100_000 }, () => [
		0, 0,
	]);
	const accepted: [[number, number][], number] = [pairs, 0];
	expect(codec.decode(codec.encode(accepted))).toEqual(accepted);
});

test("migration keys cannot normalize into a different key on another replica", async () => {
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
	const old = createPulse(Document, data(), {
		...options(),
		connectors: [connector],
	});
	const Migrated = definePulse<Document>("Document")
		.migrate<Document>("invalid-key", () => ({ ["\ud800"]: 1, "�": 2 }) as any)
		.materialize();
	const config = options();
	try {
		await connectPulse(old).synced;
		disconnectPulse(old);
		const vector = relay.getLog(old.id)!.vector;
		await expect(
			loadPulse(Migrated, old.id, {
				...config,
				connectors: [connector],
				waitFor: "all",
			}),
		).rejects.toThrow("Unsupported property");
		expect(config.scope.pulses.size).toBe(0);
		expect(relay.getLog(old.id)!.vector).toEqual(vector);
	} finally {
		destroyPulse(old);
	}
});

test("wire-size limits are checked at export, without encoding local creation or edits", () => {
	type Numbers = PulseProperties<"Numbers"> & { items: string[] };
	const Numbers = definePulse<Numbers>("Numbers").materialize();
	const values = ["x".repeat(1024 * 1024)];
	for (const initial of [values, ["small"]]) {
		const scope = createPulseScope();
		const pulse = createPulse(
			Numbers,
			{ items: initial },
			{ scope, sessionId: 65536 },
		);
		try {
			if (initial !== values) arrayOperations(pulse.items).replaceAll(values);
			const before = snapshotPulse(pulse);
			const log = getPulseMeta(pulse).log;
			const vector = log.vector;
			expect(scope.pulses.size).toBe(1);
			expect(pulse.items[0]).toBe(values[0]);
			expect(log.missing(vector)).toEqual([]);
			expect(() => log.missing([])).toThrow("Patch payload exceeds 1 MiB");
			expect(() => log.missing([])).toThrow("Patch payload exceeds 1 MiB");
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(log.vector).toEqual(vector);
		} finally {
			destroyPulse(pulse);
		}
	}
});

test("dense dependency vectors are paginated for the Rust relay's structural budget", () => {
	const vv: [number, number][] = Array.from({ length: 1024 }, (_, i) => [
		65536 + i,
		1,
	]);
	const rows = Array.from({ length: 127 }, (_, i) => ({
		docId: "dense",
		sid: 200000 + i,
		clock: 1,
		span: 1,
		dependencies: vv,
		operations: new Uint8Array([1]),
	}));
	const chunks = chunkRows(rows);
	expect(chunks.length).toBe(2);
	expect(chunks.flat()).toHaveLength(127);
	for (const rows of chunks) {
		const message = {
			kind: 2 as const,
			docId: "dense",
			requestId: 1,
			found: true,
			complete: true,
			vv,
			rows,
		};
		expect(decodeMessage(encodeMessage(message))).toEqual(message);
	}
});

for (let microtasks = 0; microtasks <= 16; microtasks++) {
	test(`initial cancellation after ${microtasks} microtasks cannot affect its replacement`, async () => {
		const relay = new PulseRelay();
		const pulse = createPulse(Document, data(), {
			...options(),
			connectors: [createMemoryConnector(relay)],
		});
		const first = connectPulse(pulse);
		const result = first.synced.then(
			() => "completed",
			(error) => error.code,
		);
		for (let i = 0; i < microtasks; i++) await Promise.resolve();
		disconnectPulse(pulse);
		const replacement = connectPulse(pulse);
		await replacement.synced;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(["completed", "CLOSED"]).toContain(await result);
		const meta = getPulseMeta(pulse);
		expect(meta.connecting).toBe(replacement);
		expect(meta.connections[0]!.status).toBe("synced");
		expect(meta.rowListeners.size).toBe(1);
		expect(relay.peerCount).toBe(1);
		pulse.nested.count = microtasks;
		await meta.connections[0]!.syncBack();
		destroyPulse(pulse);
		expect(meta.rowListeners.size).toBe(0);
		expect(relay.peerCount).toBe(0);
	});
}

test("cancellation from the connecting event cannot open or subscribe a stale transport", async () => {
	const relay = new PulseRelay();
	const pulse = createPulse(Document, data(), {
		...options(),
		connectors: [createMemoryConnector(relay)],
	});
	const connection = getPulseMeta(pulse).connections[0]!;
	connection.once("connecting", () => disconnectPulse(pulse));
	await expect(connectPulse(pulse).synced).rejects.toMatchObject({
		code: "CLOSED",
	});
	await connectPulse(pulse).synced;
	expect(getPulseMeta(pulse).rowListeners.size).toBe(1);
	expect(relay.peerCount).toBe(1);
	destroyPulse(pulse);
	expect(relay.peerCount).toBe(0);
});

test("a subscription can replace a connection while its initial download is applied", async () => {
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
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
	disconnectPulse(b);
	a.nested.count = 7;
	await getPulseMeta(a).connections[0]!.syncBack();
	let replacement: ConnectPulseResolvers<Pulse<Document>> | undefined;
	const stop = subscribePulse(b, () => {
		if (b.nested.count === 7 && !replacement) {
			disconnectPulse(b);
			replacement = connectPulse(b);
		}
	});
	const old = connectPulse(b);
	await expect(old.synced).rejects.toMatchObject({ code: "CLOSED" });
	expect(replacement).toBeDefined();
	await replacement!.synced;
	const meta = getPulseMeta(b);
	expect(meta.connecting).toBe(replacement);
	expect(meta.connections[0]!.status).toBe("synced");
	expect(meta.rowListeners.size).toBe(1);
	expect(relay.peerCount).toBe(2);
	expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
	stop();
	destroyPulse(a);
	destroyPulse(b);
	expect(relay.peerCount).toBe(0);
});
