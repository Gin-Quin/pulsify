import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	subscribePulse,
} from "../source/index.js";
import { CorePatch } from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

test("application, partial and complete object schemas retain framework metadata and stable nested IDs", () => {
	const application = {
		title: "string",
		nested: object({ count: "float64" }),
	} as const;
	const schemas = [
		object(application),
		object({ id: "string", ...application }),
		object({
			id: "string",
			kind: "string",
			version: "uint",
			generation: "uint",
			...application,
		}),
	];
	let nestedId: string | undefined;
	for (const schema of schemas) {
		const definition = definePulse("CompleteSchema", schema).materialize();
		const source = createPulse(
			definition,
			{ id: "complete-schema", title: "initial", nested: { count: 1 } },
			options(65536),
		);
		const peer = createRuntime(definition, source.id, options(65537));
		try {
			const a = getPulseMeta(source),
				b = getPulseMeta(peer);
			nestedId ??= a.model.root!.child("nested")!.id;
			expect(a.model.root!.child("nested")!.id).toBe(nestedId);
			b.applyRows(a.log.missing([]));
			expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
			(source as any).nested.count = 2;
			b.applyRows(a.log.missing(b.log.vector));
			(peer as any).title = "peer edit";
			a.applyRows(b.log.missing(a.log.vector));
			expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
			expect(source.id).toBe("complete-schema");
			expect(source.kind).toBe("CompleteSchema");
			expect(source.version).toBe(1);
			expect((snapshotPulse(source) as any).generation).toBe(0);
			const fresh = createRuntime(definition, source.id, options(65538));
			try {
				getPulseMeta(fresh).applyRows(a.log.missing([]));
				expect(snapshotPulse(fresh)).toEqual(snapshotPulse(source));
			} finally {
				destroyPulse(fresh);
			}
		} finally {
			destroyPulse(source);
			destroyPulse(peer);
		}
	}
});

test("incompatible declared metadata types reject initial creation and remote roots before commit", () => {
	for (const metadata of [{ id: "uint" }, { generation: "string" }] as const) {
		const definition = definePulse(
			"MetadataTypes",
			object({ ...metadata, title: "string" }),
		).materialize();
		const config = options(65536);
		expect(() =>
			createPulse(
				definition,
				{ id: "metadata-types", title: "initial" } as any,
				config,
			),
		).toThrow();
		expect(config.scope.pulses.size).toBe(0);
		const peer = createRuntime(definition, "metadata-types", options(65537)),
			meta = getPulseMeta(peer);
		try {
			const value = prepareValue({
				id: "metadata-types",
				kind: "MetadataTypes",
				version: 1,
				generation: 0,
				title: "initial",
			});
			const row = patchToRow(
				meta.id,
				new CorePatch(65536, 1, 1, meta.model.schemaId, [{ kind: 0, value }]),
				[],
				meta.model.encoding,
			);
			expect(() => meta.applyRows([row])).toThrow();
			expect(meta.model.root).toBeUndefined();
			expect(meta.log.vector).toEqual([]);
			expect(meta.log.size).toBe(0);
		} finally {
			destroyPulse(peer);
		}
	}
});

test("notifications snapshot listeners when a subscription replaces itself during a callback", () => {
	const definition = definePulse(
		"SnapshotListeners",
		object({ count: "uint" }),
	).materialize();
	const pulse = createPulse(definition, { count: 0 }, options(65536));
	const calls: number[] = [];
	let replaced = false;
	let stop = () => {};
	stop = subscribePulse(pulse, (current) => {
		calls.push(current.count);
		if (current.count === 1 && !replaced) {
			replaced = true;
			stop();
			stop = subscribePulse(pulse, (value) => {
				calls.push(value.count);
			});
		}
		if (calls.length > 10) throw new Error("Notification loop");
	});
	try {
		pulse.count = 1;
		expect(calls).toEqual([0, 1, 1]);
		pulse.count = 2;
		expect(calls).toEqual([0, 1, 1, 2]);
		expect(getPulseMeta(pulse).lastError).toBeUndefined();
	} finally {
		stop();
		destroyPulse(pulse);
	}
});
