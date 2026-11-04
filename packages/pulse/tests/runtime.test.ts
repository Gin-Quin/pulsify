import { expect, test } from "bun:test";
import { CorePatch, type CoreOperation } from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import {
	patchToRow,
	type PulsePatchRow,
} from "../source/connection/PulsePatch.js";
import {
	createPulse,
	connectPulse,
	createMemoryConnector,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	PulseRelay,
	snapshotPulse,
	type Pulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { PatchLog } from "../source/protocol/PatchLog.js";
import { Document, data, options } from "./helpers.js";

function remoteRow(
	meta: ReturnType<typeof getPulseMeta>,
	ops: CoreOperation[],
): PulsePatchRow {
	return patchToRow(
		meta.id,
		new CorePatch(
			meta.model.sid,
			meta.model.nextClock,
			meta.model.lamport + 1,
			meta.model.schemaId,
			ops,
		),
		meta.log.vector,
	);
}

test("incompatible metadata writes leave both the model and journal unchanged", () => {
	const pulse = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const meta = getPulseMeta(pulse);
	const before = snapshotPulse(pulse);
	const vector = meta.log.vector;
	const time = meta.model.clock.time;
	try {
		for (const [field, value] of [
			["id", "another-document"],
			["kind", "Other"],
			["version", 0],
			["version", 2],
			["generation", 1],
			["id", undefined],
		] as const) {
			const row = remoteRow(meta, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field,
					value: prepareValue(value),
				},
			]);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
			expect(meta.model.clock.time).toBe(time);
		}
	} finally {
		destroyPulse(pulse);
	}
});

test("an incompatible root replacement cannot overwrite a loaded document", () => {
	const pulse = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const meta = getPulseMeta(pulse);
	const before = snapshotPulse(pulse);
	const vector = meta.log.vector;
	try {
		for (const root of [7, { ...before, id: "another-document" }]) {
			const row = remoteRow(meta, [{ kind: 0, value: prepareValue(root) }]);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(pulse);
	}
});

test("metadata cannot be changed after a root replacement in the same transaction", () => {
	const pulse = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const meta = getPulseMeta(pulse);
	try {
		const before = snapshotPulse(pulse);
		const vector = meta.log.vector;
		const newRoot = `${meta.model.sid}:${meta.model.nextClock}:0`;
		const row = remoteRow(meta, [
			{ kind: 0, value: prepareValue(before) },
			{ kind: 1, target: newRoot, field: "kind", value: prepareValue("Other") },
		]);
		expect(() => meta.applyRows([row])).toThrow();
		expect(snapshotPulse(pulse)).toEqual(before);
		expect(meta.log.vector).toEqual(vector);
	} finally {
		destroyPulse(pulse);
	}
});

test("a batch with a valid edit followed by incompatible metadata is rejected atomically", () => {
	const source = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const target = createRuntime(Document, source.id, {
		...defaultPulseOptions,
		...options(),
		sessionId: 65537,
	}) as Pulse<Document>;
	const sourceMeta = getPulseMeta(source);
	const targetMeta = getPulseMeta(target);
	try {
		targetMeta.applyRows(sourceMeta.log.missing([]));
		const before = snapshotPulse(target);
		const vector = targetMeta.log.vector;
		source.nested.count = 17;
		const invalid = remoteRow(sourceMeta, [
			{
				kind: 1,
				target: sourceMeta.model.root!.id,
				field: "kind",
				value: prepareValue("Other"),
			},
		]);
		expect(() =>
			targetMeta.applyRows([...sourceMeta.log.missing(vector), invalid]),
		).toThrow();
		expect(snapshotPulse(target)).toEqual(before);
		expect(targetMeta.log.vector).toEqual(vector);
	} finally {
		destroyPulse(source);
		destroyPulse(target);
	}
});

for (const field of ["id", "kind", "generation"] as const)
	test(`metadata ${field} cannot be rebound even to an identical inline value`, () => {
		const pulse = createPulse(Document, data(), {
			...options(),
			sessionId: 65536,
		});
		const meta = getPulseMeta(pulse);
		try {
			const before = snapshotPulse(pulse);
			const vector = meta.log.vector;
			const row = remoteRow(meta, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field,
					value: prepareValue(pulse[field]),
				},
			]);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		} finally {
			destroyPulse(pulse);
		}
	});

test("an input object shared by fields is copied into independently editable containers", () => {
	const shared = { count: 7 };
	const pulse = createPulse(
		Document,
		{ ...data(), nested: shared, alias: shared } as any,
		options(),
	);
	try {
		pulse.nested.count = 9;
		expect((pulse as any).alias.count).toBe(7);
		expect(shared.count).toBe(7);
	} finally {
		destroyPulse(pulse);
	}
});

test("plain snapshots are detached and preserve undefined, arrays and constants", () => {
	const pulse = createPulse(Document, data(), options());
	try {
		Reflect.set(pulse, "optional", undefined);
		const snapshot = snapshotPulse(pulse);
		snapshot.nested.count = 99;
		snapshot.items[0]!.value = 99;
		expect(pulse.nested.count).toBe(0);
		expect(pulse.items[0]!.value).toBe(1);
		expect(snapshot.optional).toBeUndefined();
	} finally {
		destroyPulse(pulse);
	}
});

test("native journal output owns its metadata and cached encoded bytes", () => {
	const create = new CorePatch(65537, 1, 1, "", [
		{ kind: 0, value: prepareValue("value") },
	]);
	const log = new PatchLog("owned-native");
	let encodes = 0;
	const row = log.appendPatch(create, (docId, patch, dependencies) => {
		encodes++;
		return patchToRow(docId, patch, dependencies);
	})[0]!;
	expect(encodes).toBe(0);
	expect(log.missing(log.vector)).toEqual([]);
	expect(encodes).toBe(0);
	row.docId = "changed";
	row.dependencies.push([99999, 1]);
	const expected = log.missing([])[0]!;
	row.operations.fill(0);
	log.missing([])[0]!.operations.fill(1);
	expect(log.missing([])[0]).toEqual(expected);
	expect(expected.docId).toBe("owned-native");
	expect(expected.dependencies).toEqual([]);
	expect(encodes).toBe(1);
});

test("rejected native entries never consume the committed encoded-byte quota", () => {
	const patch = (size: number) => {
		return new CorePatch(65537, 1, 1, "", [
			{ kind: 0, value: prepareValue("x".repeat(size)) },
		]);
	};
	const large = patch(900_000);
	for (const readAfterRejection of [false, true]) {
		const log = new PatchLog("cancelled-native");
		for (let i = 0; i < 74; i++) {
			let rejected: PulsePatchRow | undefined;
			expect(() =>
				log.appendPatch(large, patchToRow, (rows) => {
					rejected = rows[0]!;
					if (!readAfterRejection)
						expect(rejected.operations.length).toBeGreaterThan(900_000);
					throw new Error("cancelled");
				}),
			).toThrow("cancelled");
			if (readAfterRejection)
				expect(rejected!.operations.length).toBeGreaterThan(900_000);
		}
		expect(log.size).toBe(0);
		expect(log.vector).toEqual([]);
		log.appendPatch(patch(600_000), patchToRow);
		expect(log.missing([])[0]!.operations.length).toBeGreaterThan(600_000);
		expect(log.size).toBe(1);
	}
});

test("local patches keep detached initial values until their first export", () => {
	const input = data();
	const original = structuredClone(input);
	const pulse = createPulse(Document, input, {
		...options(),
		sessionId: 65536,
	});
	const peer = createRuntime(Document, pulse.id, {
		...defaultPulseOptions,
		...options(),
		sessionId: 65537,
	}) as Pulse<Document>;
	try {
		input.title = "external";
		input.nested.count = 99;
		input.items[0]!.value = 99;
		getPulseMeta(peer).applyRows(getPulseMeta(pulse).log.missing([]));
		expect(peer.title).toBe(original.title);
		expect(peer.nested.count).toBe(original.nested.count);
		expect(peer.items[0]!.value).toBe(original.items[0]!.value);
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
	} finally {
		destroyPulse(pulse);
		destroyPulse(peer);
	}
});

test("connect true exports the native initial history and subsequent edits", async () => {
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
	const pulse = createPulse(Document, data(), {
		...options(),
		connect: true,
		connectors: [connector],
	});
	let peer: Awaited<ReturnType<typeof loadPulse<typeof Document>>> | undefined;
	try {
		await connectPulse(pulse).synced;
		expect(relay.getLog(pulse.id)!.size).toBe(1);
		pulse.nested.count = 7;
		await getPulseMeta(pulse).connections[0]!.syncBack();
		peer = await loadPulse(Document, pulse.id, {
			...options(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
		expect(peer.nested.count).toBe(7);
	} finally {
		if (peer) destroyPulse(peer);
		destroyPulse(pulse);
	}
});

test("a native local commit releases causally dependent incoming rows", () => {
	const pulse = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const peer = createRuntime(Document, pulse.id, {
		...defaultPulseOptions,
		...options(),
		sessionId: 65537,
	}) as Pulse<Document>;
	const meta = getPulseMeta(pulse);
	const remote = getPulseMeta(peer);
	try {
		remote.applyRows(meta.log.missing([]));
		const next = remoteRow(meta, [
			{
				kind: 1,
				target: meta.model.root!.children.get("nested")!.id,
				field: "count",
				value: prepareValue(1),
			},
		]);
		remote.applyRows([next]);
		peer.title = "causally-after-local-edit";
		meta.applyRows(
			remote.log.missing(remote.log.vector.filter(([sid]) => sid !== 65537)),
		);
		expect(meta.log.pendingCount).toBe(1);
		pulse.nested.count = 1;
		expect(meta.log.pendingCount).toBe(0);
		expect(snapshotPulse(pulse)).toEqual(snapshotPulse(peer));
		expect(meta.log.vector).toEqual(remote.log.vector);
	} finally {
		destroyPulse(pulse);
		destroyPulse(peer);
	}
});
