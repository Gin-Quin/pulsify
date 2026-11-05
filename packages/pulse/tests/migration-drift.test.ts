import { expect, spyOn, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	applyPulseUpdates,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	loadPulse,
	MigrationDriftError,
	snapshotPulse,
} from "../source/index.js";
import * as fingerprints from "../source/utilities/fingerprint.js";
import { schemaFingerprint } from "../source/core/schema.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { CorePatch } from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import { patchToRow } from "../source/connection/PulsePatch.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const v1 = object({ title: "string" });
const v2 = object({ title: "string", published: "boolean" });
const v3 = object({ title: "string", published: "boolean" });
const initial = definePulse("MigrationDrift", v1);

function definition(changedHistory = false) {
	const middle = changedHistory
		? object({ published: "boolean", title: "string" })
		: v2;
	return definePulse("MigrationDrift", v1)
		.migrateTo(middle, () => ({ published: false }))
		.migrateTo(v3, () => ({}))
		.materialize();
}

test("migration fingerprints are recursive, deterministic, cached and prefix-compatible", () => {
	const base = initial.materialize();
	const secondBuilder = initial.migrateTo(v2, () => ({ published: false }));
	const second = secondBuilder.materialize();
	const third = secondBuilder.migrateTo(v3, () => ({})).materialize();
	// These are wire identities: changing them requires an explicit compatibility decision.
	expect(third.migrationChain!.fingerprints).toEqual([
		"ccfc11a6537ef96a731dea947285e996",
		"1e4671d725d55c8b366c9d610d6ca19f",
		"f172530840dca3a80ffeabd470ec0d24",
	]);
	expect(secondBuilder.materialize().migrationChain).toBe(
		second.migrationChain,
	);
	expect(third.migrationChain!.fingerprints.slice(0, 2)).toEqual([
		...second.migrationChain!.fingerprints,
	]);
	expect(second.migrationChain!.fingerprints[0]).toBe(
		base.migrationChain!.fingerprints[0],
	);
	expect(definition().migrationChain!.schemaIds).toEqual(
		third.migrationChain!.schemaIds,
	);
	expect(schemaFingerprint(definition(true).compiledSchema!)).toBe(
		schemaFingerprint(third.compiledSchema!),
	);
	expect(definition(true).migrationChain!.fingerprints[0]).toBe(
		third.migrationChain!.fingerprints[0],
	);
	expect(definition(true).migrationChain!.fingerprints[1]).not.toBe(
		third.migrationChain!.fingerprints[1],
	);
	expect(definition(true).migrationChain!.fingerprints[2]).not.toBe(
		third.migrationChain!.fingerprints[2],
	);
	expect(base.migrationChain!.schemaIds[0]).toBe(
		schemaFingerprint(base.compiledSchema!),
	);
	expect(third.migrationChain!.schemaIds[2]).toMatch(/^m3:[0-9a-f]{32}$/);
	const otherKind = definePulse("OtherKind", v1)
		.migrateTo(v2, () => ({ published: false }))
		.materialize();
	expect(otherKind.migrationChain!.fingerprints[1]).not.toBe(
		second.migrationChain!.fingerprints[1],
	);
	const annotated = initial
		.migrateTo(v2, () => ({ published: false }), {
			constantPaths: [["published"]],
		})
		.materialize();
	expect(annotated.migrationChain!.fingerprints[1]).not.toBe(
		second.migrationChain!.fingerprints[1],
	);
	// The agreed fingerprint covers schemas/annotations, not callback source text.
	const differentCallback = initial
		.migrateTo(v2, () => ({ published: true }))
		.materialize();
	expect(differentCallback.migrationChain!.fingerprints).toEqual(
		second.migrationChain!.fingerprints,
	);
});

test("a rewritten earlier schema rejects a fresh latest root and logs detached diagnostics once", () => {
	const original = definition();
	const changed = definition(true);
	const source = createPulse(
		original,
		{ title: "Draft", published: false },
		options(65536),
	);
	const peer = createRuntime(changed, source.id, options(65537));
	const meta = getPulseMeta(peer);
	const rows = getPulseMeta(source).log.missing([]);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(() => meta.applyRows(rows)).toThrow(MigrationDriftError);
		expect(meta.log.size).toBe(0);
		expect(meta.log.vector).toEqual([]);
		expect(meta.model.root).toBeUndefined();
		expect(meta.model.lamport).toBe(0);
		expect(meta.lastError).toBeInstanceOf(MigrationDriftError);
		expect(warning).toHaveBeenCalledTimes(1);
		const [banner, report] = warning.mock.calls[0]! as [string, any];
		expect(banner).toContain("MIGRATION DRIFT DETECTED");
		expect(banner).toBe(banner.toUpperCase());
		expect(report).toMatchObject({
			docId: source.id,
			kind: original.kind,
			version: 3,
			expected: changed.migrationChain!.schemaIds[2],
			received: original.migrationChain!.schemaIds[2],
			snapshot: {},
			incomingSnapshot: snapshotPulse(source),
			incomingSnapshotUsesLocalSchema: true,
		});
		expect(report.localMigration.fromVersion).toBe(2);
		expect(report.localMigration.toVersion).toBe(3);
		expect(report.localMigration.fromSchema.layouts[0].fields[0].name).toBe(
			"published",
		);
		expect(report.localMigration.toSchema.layouts[0].fields[0].name).toBe(
			"title",
		);
		expect(report.incomingPatch.operations).not.toBe(rows[0]!.operations);
		report.incomingSnapshot.title = "Diagnostic edit";
		report.localMigration.toSchema.layouts[0].fields[0].name =
			"Diagnostic edit";
		expect(source.title).toBe("Draft");
		expect(changed.compiledSchema!.root.fields[0]!.key).toBe("title");
		expect(() => meta.applyRows(rows)).toThrow(MigrationDriftError);
		expect(warning).toHaveBeenCalledTimes(1);
	} finally {
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});

for (const peerVersion of [1, 2, 3] as const) {
	test(`drift rejects edits of a loaded document atomically (transport ${peerVersion})`, () => {
		const seed = createPulse(
			initial.materialize(),
			{ title: "Initial" },
			options(65536),
		);
		const source = createRuntime(definition(), seed.id, options(65537));
		const target = createRuntime(definition(true), seed.id, options(65538));
		const a = getPulseMeta(source),
			b = getPulseMeta(target);
		const warning = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const base = getPulseMeta(seed).log.missing([]);
			a.applyRows(base);
			b.applyRows(base);
			const before = snapshotPulse(target),
				vector = b.log.vector,
				size = b.log.size;
			const frontier = a.log.vector;
			for (let i = 0; i < 40; i++) source["title"] = `Edit ${i}`;
			const frames = exportPulseUpdates(source, frontier, { peerVersion });
			expect(() => applyPulseUpdates(target, frames)).toThrow(
				MigrationDriftError,
			);
			expect(snapshotPulse(target)).toEqual(before);
			expect(b.log.vector).toEqual(vector);
			expect(b.log.size).toBe(size);
			expect(b.log.pendingCount).toBe(0);
			expect(warning).toHaveBeenCalledTimes(1);
			expect((warning.mock.calls[0]![1] as any).snapshot).toEqual(before);
		} finally {
			warning.mockRestore();
			destroyPulse(seed);
			destroyPulse(source);
			destroyPulse(target);
		}
	});
}

test("matching prefixes migrate normally; a newer client version is not reported as drift", () => {
	const secondBuilder = initial.migrateTo(v2, () => ({ published: false }));
	const second = secondBuilder.materialize();
	const third = secondBuilder.migrateTo(v3, () => ({})).materialize();
	const source = createPulse(
		second,
		{ title: "Ready", published: false },
		options(65536),
	);
	const peer = createRuntime(third, source.id, options(65537));
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		getPulseMeta(peer).applyRows(getPulseMeta(source).log.missing([]));
		expect(peer.version).toBe(3);
		expect(peer["title"]).toBe("Ready");
		expect(() =>
			getPulseMeta(source).applyRows(getPulseMeta(peer).log.missing([])),
		).toThrow("newer migration version");
		expect(warning).not.toHaveBeenCalled();
	} finally {
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("loadPulse reports migration drift through its normal error channel", async () => {
	const connector = createMemoryConnector();
	const source = createPulse(
		definition(),
		{ title: "Remote", published: false },
		{ ...options(65536), connectors: [connector] },
	);
	const scope = createPulseScope();
	const errors: Error[] = [];
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		await connectPulse(source).synced;
		await expect(
			loadPulse(definition(true), source.id, {
				...options(65537),
				scope,
				connectors: [connector],
				onError: (error) => errors.push(error),
			}),
		).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
		expect(scope.pulses.size).toBe(0);
		expect(errors.some((error) => error instanceof MigrationDriftError)).toBe(
			true,
		);
		expect(warning).toHaveBeenCalledTimes(1);
	} finally {
		warning.mockRestore();
		destroyPulse(source);
	}
});

test("a throwing warning logger cannot mask or bypass drift rejection", () => {
	const source = createPulse(
		definition(),
		{ title: "Remote", published: false },
		options(65536),
	);
	const peer = createRuntime(definition(true), source.id, options(65537));
	const warning = spyOn(console, "warn").mockImplementation(() => {
		throw new Error("Logger failed");
	});
	try {
		expect(() =>
			getPulseMeta(peer).applyRows(getPulseMeta(source).log.missing([])),
		).toThrow(MigrationDriftError);
		expect(getPulseMeta(peer).log.size).toBe(0);
		expect(getPulseMeta(peer).model.root).toBeUndefined();
	} finally {
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("drift diagnostics do not invoke application materializer getters", () => {
	const changed = definition(true);
	let reads = 0;
	changed.materializer = () => ({
		title: {
			get() {
				reads++;
				throw new Error("Application getter failed");
			},
			set() {},
		},
	});
	const source = createPulse(
		definition(),
		{ title: "Remote", published: false },
		options(65536),
	);
	const peer = createPulse(
		changed,
		{ id: source.id, title: "Local", published: false },
		options(65537),
	);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(() =>
			getPulseMeta(peer).applyRows(getPulseMeta(source).log.missing([])),
		).toThrow(MigrationDriftError);
		expect(reads).toBe(0);
		expect(warning).toHaveBeenCalledTimes(1);
		expect((warning.mock.calls[0]![1] as any).snapshot.title).toBe("Local");
	} finally {
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("an old layout-only migration cannot impersonate a guarded version transition", () => {
	const base = initial.materialize();
	const latest = initial.migrateTo(v1, () => ({})).materialize();
	const source = createPulse(base, { title: "Original" }, options(65536));
	const peer = createRuntime(latest, source.id, options(65537));
	const meta = getPulseMeta(peer);
	meta.applyRows(getPulseMeta(source).log.missing([]));
	const before = snapshotPulse(peer),
		vector = meta.log.vector,
		size = meta.log.size;
	const root = meta.model.root!.id;
	const patch = new CorePatch(
		65538,
		1,
		100,
		base.migrationChain!.schemaIds[0]!,
		[
			{
				kind: 1,
				target: root,
				field: "title",
				value: prepareValue("Unverified"),
			},
			{ kind: 1, target: root, field: "version", value: prepareValue(2) },
		],
	);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(() =>
			meta.applyRows([patchToRow(source.id, patch, vector)]),
		).toThrow(MigrationDriftError);
		expect(snapshotPulse(peer)).toEqual(before);
		expect(meta.log.size).toBe(size);
		expect(meta.log.vector).toEqual(vector);
		expect(warning).toHaveBeenCalledTimes(1);
	} finally {
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("a local edit unlocking pending drift logs the rejection without committing either patch", () => {
	const builder = definePulse("PendingMigrationDrift", v1);
	const original = builder.materialize();
	const latest = builder.migrateTo(v1, () => ({})).materialize();
	const peer = createPulse(latest, { title: "Initial" }, options(65537));
	const meta = getPulseMeta(peer);
	const bad = new CorePatch(
		65538,
		1,
		10,
		original.migrationChain!.schemaIds[0]!,
		[
			{
				kind: 1,
				target: meta.model.root!.id,
				field: "version",
				value: prepareValue(2),
			},
		],
	);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	let notifications = 0;
	meta.listeners.add(() => notifications++);
	try {
		meta.applyRows([patchToRow(peer.id, bad, [[65537, 3]])]);
		expect(meta.log.pendingCount).toBe(1);
		expect(warning).not.toHaveBeenCalled();
		const before = snapshotPulse(peer),
			vector = meta.log.vector,
			size = meta.log.size;
		const lamport = meta.model.lamport,
			nextClock = meta.model.nextClock;
		expect(() => {
			peer.title = "Local edit";
		}).toThrow(MigrationDriftError);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(meta.lastError).toBeInstanceOf(MigrationDriftError);
		expect((warning.mock.calls[0]![1] as any).snapshot).toEqual(before);
		expect(snapshotPulse(peer)).toEqual(before);
		expect(meta.log.vector).toEqual(vector);
		expect(meta.log.size).toBe(size);
		expect(meta.log.pendingCount).toBe(1);
		expect(meta.model.lamport).toBe(lamport);
		expect(meta.model.nextClock).toBe(nextClock);
		expect(notifications).toBe(0);
		expect(() => {
			peer.title = "Retry";
		}).toThrow(MigrationDriftError);
		expect(warning).toHaveBeenCalledTimes(1);
	} finally {
		warning.mockRestore();
		destroyPulse(peer);
	}
});

test("ordinary creation, edits and replay share the chain without hashing or diagnostic copies", () => {
	const current = definition();
	const source = createPulse(
		current,
		{ title: "Initial", published: false },
		options(65536),
	);
	const peer = createRuntime(current, source.id, options(65537));
	getPulseMeta(peer).applyRows(getPulseMeta(source).log.missing([]));
	const hash = spyOn(fingerprints, "fingerprintBytes");
	const clone = spyOn(globalThis, "structuredClone");
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		for (let i = 0; i < 50; i++) {
			source.title = `Edit ${i}`;
			getPulseMeta(peer).applyRows(
				getPulseMeta(source).log.missing(getPulseMeta(peer).log.vector),
			);
			const fresh = createPulse(
				current,
				{ title: "Fresh", published: false },
				options(65538),
			);
			expect(getPulseMeta(fresh).model.migrationChain).toBe(
				current.migrationChain,
			);
			destroyPulse(fresh);
		}
		expect(peer["title"]).toBe("Edit 49");
		expect(hash).not.toHaveBeenCalled();
		expect(clone).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
	} finally {
		hash.mockRestore();
		clone.mockRestore();
		warning.mockRestore();
		destroyPulse(source);
		destroyPulse(peer);
	}
});
