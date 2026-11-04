import { expect, test } from "bun:test";
import { ClockVector } from "json-joy/lib/json-crdt-patch/clock/index.js";
import { PatchBuilder } from "json-joy/lib/json-crdt-patch/PatchBuilder.js";
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
import { toNodeBuilder } from "../source/utilities/toNodeBuilder.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { PatchLog } from "../source/protocol/PatchLog.js";
import { Document, data, options } from "./helpers.js";

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
			const builder = new PatchBuilder(meta.model.clock.clone());
			builder.insObj(meta.model.api.obj().node.id, [
				[field, builder.con(value)],
			]);
			const row = patchToRow(meta.id, builder.flush(), vector);
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
			const builder = new PatchBuilder(meta.model.clock.clone());
			builder.root(builder.json(toNodeBuilder(root)));
			const row = patchToRow(meta.id, builder.flush(), vector);
			expect(() => meta.applyRows([row])).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(pulse);
	}
});

test("root metadata references ignored by json-joy cannot pass compatibility checks", () => {
	const pulse = createPulse(Document, data(), {
		...options(),
		sessionId: 65536,
	});
	const meta = getPulseMeta(pulse);
	try {
		const before = snapshotPulse(pulse);
		const vector = meta.log.vector;
		const builder = new PatchBuilder(meta.model.clock.clone());
		const root = builder.obj();
		builder.insObj(
			root,
			[...meta.model.api.obj().node.keys].filter(([field]) =>
				["id", "kind", "version", "generation"].includes(field),
			),
		);
		builder.root(root);
		const row = patchToRow(meta.id, builder.flush(), vector);
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
		const builder = new PatchBuilder(sourceMeta.model.clock.clone());
		builder.insObj(sourceMeta.model.api.obj().node.id, [
			["kind", builder.con("Other")],
		]);
		const invalid = patchToRow(
			source.id,
			builder.flush(),
			sourceMeta.log.vector,
		);
		expect(() =>
			targetMeta.applyRows([...sourceMeta.log.missing(vector), invalid]),
		).toThrow("incompatible");
		expect(snapshotPulse(target)).toEqual(before);
		expect(targetMeta.log.vector).toEqual(vector);
	} finally {
		destroyPulse(source);
		destroyPulse(target);
	}
});

for (const alias of ["root", "field", "existing"] as const)
	test(`metadata cannot share nodes with another ${alias}`, () => {
		const pulse = createPulse(Document, data(), {
			...options(),
			sessionId: 65536,
		});
		const meta = getPulseMeta(pulse);
		try {
			if (alias === "existing") pulse.optional = pulse.id;
			const before = snapshotPulse(pulse);
			const vector = meta.log.vector;
			const builder = new PatchBuilder(meta.model.clock.clone());
			const root = meta.model.api.obj().node.id;
			if (alias === "field") {
				const ref = builder.con(pulse.id);
				builder.insObj(root, [
					["id", ref],
					["alias", ref],
				]);
			} else if (alias === "existing") {
				builder.insObj(root, [
					["id", meta.model.api.obj().node.keys.get("optional")!],
				]);
			} else {
				const next = builder.obj();
				const fields: [string, ReturnType<typeof builder.con>][] = [
					["id", builder.con(pulse.id)],
					["kind", builder.con("Document")],
					["version", builder.con(1)],
				];
				builder.insObj(root, fields);
				builder.insObj(next, fields);
				builder.root(next);
			}
			const row = patchToRow(meta.id, builder.flush(), vector);
			expect(() => meta.applyRows([row])).toThrow("cannot share");
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(meta.log.vector).toEqual(vector);
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
	const create = new PatchBuilder(new ClockVector(65537, 1));
	create.root(create.con("value"));
	const log = new PatchLog("owned-native");
	let encodes = 0;
	const row = log.appendPatch(create.flush(), (docId, patch, dependencies) => {
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
		const builder = new PatchBuilder(new ClockVector(65537, 1));
		builder.root(builder.con("x".repeat(size)));
		return builder.flush();
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
		const next = new PatchBuilder(meta.model.clock.clone());
		next.insObj(meta.model.api.obj(["nested"]).node.id, [
			["count", next.con(1)],
		]);
		remote.applyRows([patchToRow(meta.id, next.flush(), meta.log.vector)]);
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
