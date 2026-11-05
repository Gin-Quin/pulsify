import { expect, test } from "bun:test";
import { array, map, object } from "@gin-quin/codec";
import {
	patchToRow,
	type PulsePatchRow,
} from "../source/connection/PulsePatch.js";
import { CorePatch, type CoreOperation } from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import type { AnyPulseDefinition } from "../source/pulses/PulseDefinition.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
function replicas(definition: AnyPulseDefinition, id: string) {
	// Identical peer actors also make any generated migration rows comparable.
	const fast = createRuntime(definition, id, options(65539));
	const general = createRuntime(definition, id, options(65539));
	const notifications = [0, 0],
		rowNotifications = [0, 0];
	for (const [i, pulse] of [fast, general].entries()) {
		getPulseMeta(pulse).listeners.add(() => {
			notifications[i] = notifications[i]! + 1;
		});
		getPulseMeta(pulse).rowListeners.add(() => {
			rowNotifications[i] = rowNotifications[i]! + 1;
		});
	}
	const state = (pulse: typeof fast) => {
		const meta = getPulseMeta(pulse);
		return {
			value: snapshotPulse(pulse),
			rows: meta.log.missing([]),
			vector: meta.log.vector,
			size: meta.log.size,
			pending: meta.log.pendingCount,
			loaded: meta.loaded,
			clock: meta.model.nextClock,
			lamport: meta.model.lamport,
			nodes: [...meta.model.index.keys()],
			layout: meta.model.root?.layout?.id,
		};
	};
	const run = (pulse: typeof fast, rows: PulsePatchRow[]) => {
		try {
			getPulseMeta(pulse).applyRows(rows);
			return undefined;
		} catch (error) {
			return {
				name: (error as Error).name,
				message: (error as Error).message,
				code: (error as { code?: string }).code,
			};
		}
	};
	return {
		fast,
		general,
		notifications,
		state: () => state(fast),
		deliver(row: PulsePatchRow) {
			const error = run(fast, [row]);
			// A duplicate row selects the multi-row runtime branch without adding
			// another journal operation or changing the set of available patches.
			expect(run(general, [row, row])).toEqual(error);
			expect(state(fast)).toEqual(state(general));
			expect(notifications[0]).toBe(notifications[1]);
			expect(rowNotifications[0]).toBe(rowNotifications[1]);
			return error;
		},
		destroy() {
			destroyPulse(fast);
			destroyPulse(general);
		},
	};
}

const definition = definePulse(
	"SingleRowReview",
	object({
		count: "uint",
		profile: object({ label: "string" }),
		items: array("uint"),
		body: "string",
	}),
	{ richTextPaths: [["body"]] },
).materialize();
const initial = {
	count: 0,
	profile: { label: "original" },
	items: [1],
	body: "a",
};

test("single-row delivery matches general delivery for gaps, duplicates, containers and rich text", () => {
	const source = createPulse(definition, initial, options(65536));
	const pair = replicas(definition, source.id);
	try {
		source.count = 1;
		source.profile = { label: "replacement" };
		source.items.push(2);
		source.body.insert(1, "bc");
		source.body.format(0, 1, { bold: true });
		(source as any).body = "reset";
		source.count = 2;
		const rows = getPulseMeta(source).log.missing([]);
		for (const index of [0, 2, 1, 3, 3, 4, 5, 6, 7, 7])
			expect(pair.deliver(rows[index]!)).toBeUndefined();
		expect(snapshotPulse(pair.fast)).toEqual(snapshotPulse(source));
		expect(pair.notifications[0]).toBe(7);
	} finally {
		pair.destroy();
		destroyPulse(source);
	}
});

test("single-row validation preserves the same atomic failures and notification behavior", () => {
	for (const scenario of [
		"wrong-type",
		"unknown-field",
		"unknown-target",
		"metadata",
		"uncovered-target",
		"fingerprint",
		"truncated",
		"metadata-marker",
	] as const) {
		const source = createPulse(definition, initial, options(65536));
		const pair = replicas(definition, source.id);
		try {
			const sourceMeta = getPulseMeta(source),
				root = sourceMeta.model.root!;
			pair.deliver(sourceMeta.log.missing([])[0]!);
			const before = pair.state(),
				notifications = pair.notifications[0];
			let ops: CoreOperation[] = [
				{ kind: 1, target: root.id, field: "count", value: prepareValue(3) },
			];
			let schema = sourceMeta.model.schemaId,
				dependencies = sourceMeta.log.vector;
			if (scenario === "wrong-type")
				ops = [
					{
						kind: 1,
						target: root.id,
						field: "count",
						value: prepareValue("wrong"),
					},
				];
			if (scenario === "unknown-field")
				ops = [
					{ kind: 1, target: root.id, field: "extra", value: prepareValue(3) },
				];
			if (scenario === "unknown-target")
				ops = [
					{
						kind: 1,
						target: "65536:1:9999",
						field: "count",
						value: prepareValue(3),
					},
				];
			if (scenario === "metadata")
				ops = [
					{
						kind: 1,
						target: root.id,
						field: "id",
						value: prepareValue(source.id),
					},
				];
			if (scenario === "uncovered-target") dependencies = [];
			if (scenario === "fingerprint") schema = "0".repeat(32);
			if (scenario === "metadata-marker") {
				const value = prepareValue(snapshotPulse(source));
				value.texts = [["id"]];
				ops = [{ kind: 0, value }];
			}
			let row = patchToRow(
				source.id,
				new CorePatch(65536, 2, 2, schema, ops),
				dependencies,
			);
			if (scenario === "truncated")
				row = {
					...row,
					operations: row.operations.subarray(0, row.operations.length - 1),
				};
			expect(pair.deliver(row)).toBeDefined();
			expect(pair.state()).toEqual(before);
			expect(pair.notifications[0]).toBe(notifications);
		} finally {
			pair.destroy();
			destroyPulse(source);
		}
	}
});

test("an invalid pending patch cannot make its gap-closing predecessor partially commit", () => {
	const source = createPulse(definition, initial, options(65536));
	const pair = replicas(definition, source.id);
	try {
		const meta = getPulseMeta(source),
			root = meta.model.root!;
		pair.deliver(meta.log.missing([])[0]!);
		const invalid = patchToRow(
			source.id,
			new CorePatch(65536, 3, 3, meta.model.schemaId, [
				{
					kind: 1,
					target: root.id,
					field: "count",
					value: prepareValue("wrong"),
				},
			]),
			[[65536, 3]],
		);
		expect(pair.deliver(invalid)).toBeUndefined();
		const before = pair.state(),
			notifications = pair.notifications[0];
		const valid = patchToRow(
			source.id,
			new CorePatch(65536, 2, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: root.id,
					field: "count",
					value: prepareValue(3),
				},
			]),
			[[65536, 2]],
		);
		expect(pair.deliver(valid)).toBeDefined();
		expect(pair.state()).toEqual(before);
		expect(pair.notifications[0]).toBe(notifications);
	} finally {
		pair.destroy();
		destroyPulse(source);
	}
});

test("single-row root-map migration captures match general migration bytes and late edits", () => {
	const schema = map(object({ count: "uint" }));
	const builder = definePulse("SingleRowMapMigration", schema),
		oldDefinition = builder.materialize();
	const latest = builder
		.migrate(() => ({ added: { count: 2 } }) as any)
		.schema(schema, { constantPaths: [["*"]] })
		.materialize();
	const source = createPulse(
		oldDefinition,
		{ first: { count: 1 } },
		options(65536),
	);
	const pair = replicas(latest, source.id);
	try {
		const meta = getPulseMeta(source);
		expect(pair.deliver(meta.log.missing([])[0]!)).toBeUndefined();
		expect(pair.fast.version).toBe(2);
		source["first"]!.count = 9;
		expect(pair.deliver(meta.log.missing([[65536, 2]])[0]!)).toBeUndefined();
		expect((snapshotPulse(pair.fast) as any).first).toEqual({ count: 1 });
		expect((snapshotPulse(pair.fast) as any).added).toEqual({ count: 2 });
	} finally {
		pair.destroy();
		destroyPulse(source);
	}
});
