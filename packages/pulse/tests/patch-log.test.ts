import { expect, test } from "bun:test";
import { CorePatch } from "../source/core/operations";
import { prepareValue } from "../source/core/values";
import {
	patchToRow,
	type PulsePatchRow,
} from "../source/connection/PulsePatch";
import {
	MAX_VECTOR_ENTRIES,
	type PulseVersionVector,
} from "../source/connection/PulseVersionVector";
import { MAX_LOG_ROWS, PatchLog } from "../source/protocol/PatchLog";

const docId = "journal-contract";
function patch(clock: number, sid = 65536): CorePatch {
	return new CorePatch(sid, clock, clock, "", [
		{ kind: 0, value: prepareValue(clock) },
	]);
}
function row(
	clock: number,
	sid = 65536,
	dependencies?: PulseVersionVector,
): PulsePatchRow {
	return patchToRow(
		docId,
		patch(clock, sid),
		dependencies ?? (clock > 1 ? [[sid, clock]] : []),
	);
}

test("journal: immutable local dependency snapshots survive later actor advances", () => {
	const log = new PatchLog(docId);
	log.appendLocalPatch(patch(1), patchToRow);
	log.appendLocalPatch(patch(1, 65537), patchToRow);
	log.appendLocalPatch(patch(2), patchToRow);
	const rows = log.missing([]);
	expect(
		rows.find((item) => item.sid === 65536 && item.clock === 1)!.dependencies,
	).toEqual([]);
	expect(rows.find((item) => item.sid === 65537)!.dependencies).toEqual([
		[65536, 2],
	]);
	expect(
		rows.find((item) => item.sid === 65536 && item.clock === 2)!.dependencies,
	).toEqual([
		[65536, 2],
		[65537, 2],
	]);
	const vector = log.vector;
	vector[0]![1] = 999;
	expect(log.vector).toEqual([
		[65536, 3],
		[65537, 2],
	]);
});

test("journal: a gap cannot advance the frontier even without declared predecessor metadata", () => {
	const log = new PatchLog(docId);
	expect(log.append([row(3, 65536, [])])).toEqual([]);
	expect(log.vector).toEqual([]);
	expect(log.pendingCount).toBe(1);
});

test("journal: reverse batches close contiguous gaps across dependent actors", () => {
	const log = new PatchLog(docId);
	const rows = [
		row(1),
		row(2),
		row(1, 65537, [[65536, 3]]),
		row(2, 65537, [
			[65536, 3],
			[65537, 2],
		]),
	];
	expect(log.appendRemoteRows([...rows].reverse())).toHaveLength(4);
	expect(log.vector).toEqual([
		[65536, 3],
		[65537, 3],
	]);
	expect(log.pendingCount).toBe(0);
	expect(log.append(rows)).toEqual([]);
	expect(log.size).toBe(4);
});

test("journal: a new local transaction can release pending remote rows", () => {
	const log = new PatchLog(docId);
	log.appendLocalPatch(patch(1), patchToRow);
	expect(log.appendRemoteRows([row(1, 65537, [[65536, 3]])])).toEqual([]);
	const ready = log.appendLocalPatch(patch(2), patchToRow);
	expect(ready).toHaveLength(2);
	expect(log.pendingCount).toBe(0);
	expect(log.vector).toEqual([
		[65536, 3],
		[65537, 2],
	]);
});

test("journal: public precommit callbacks cannot mutate persisted metadata or bytes", () => {
	const log = new PatchLog(docId);
	const incoming = row(1);
	const expected = structuredClone(incoming);
	log.append([incoming], (available) => {
		available[0]!.clock = 99;
		available[0]!.dependencies.push([99999, 1]);
		available[0]!.operations.fill(0);
	});
	expect(log.vector).toEqual([[65536, 2]]);
	expect(log.missing([])).toEqual([expected]);
});

test("journal: aborting public callbacks preserves existing dangling rows and frontier", () => {
	const log = new PatchLog(docId);
	const later = row(2);
	log.append([later]);
	const expected = log.missing([]);
	expect(() =>
		log.append([row(1)], (available) => {
			for (const item of available) {
				item.clock = 99;
				item.operations.fill(0);
			}
			throw new Error("reject batch");
		}),
	).toThrow("reject batch");
	expect(log.size).toBe(1);
	expect(log.pendingCount).toBe(1);
	expect(log.vector).toEqual([]);
	expect(log.missing([])).toEqual(expected);
	expect(log.append([row(1)])).toHaveLength(2);
	expect(log.pendingCount).toBe(0);
});

test("journal: public native callbacks cannot mutate dependency snapshots", () => {
	const log = new PatchLog(docId);
	log.appendLocalPatch(patch(1), patchToRow);
	log.appendPatch(patch(2), patchToRow, (available) => {
		available[0]!.dependencies[0]![1] = 99;
		available[0]!.operations.fill(0);
	});
	expect(log.missing([])[1]!.dependencies).toEqual([[65536, 2]]);
	expect(log.missing([])[1]!.operations.some((byte) => byte !== 0)).toBe(true);
});

test("journal: internal receive still owns copies of caller-owned input buffers", () => {
	const incoming = row(1);
	const expected = structuredClone(incoming);
	const log = new PatchLog(docId);
	log.appendRemoteRows([incoming]);
	incoming.operations.fill(0);
	incoming.dependencies.push([99999, 1]);
	const output = log.missing([]);
	output[0]!.operations.fill(1);
	expect(log.missing([])).toEqual([expected]);
});

test("journal: single remote deliveries retain fork checks, duplicate identity and atomic preflight", () => {
	const log = new PatchLog(docId);
	log.appendRemoteRows([row(1)]);
	expect(() => log.appendRemoteRows([row(2, 65536, [])])).toThrow("fork");
	expect(() =>
		log.appendRemoteRows([row(2)], () => {
			throw new Error("reject");
		}),
	).toThrow("reject");
	expect(log.size).toBe(1);
	expect(log.vector).toEqual([[65536, 2]]);
	expect(log.appendRemoteRows([row(1)])).toEqual([]);
	const conflict = row(1);
	conflict.operations = conflict.operations.slice();
	conflict.operations[0] = conflict.operations[0]! ^ 1;
	expect(() => log.appendRemoteRows([conflict])).toThrow("same operation ID");
	expect(log.appendRemoteRows([row(2)])).toHaveLength(1);
	expect(log.vector).toEqual([[65536, 3]]);
});

test("journal: single remote delivery enforces the actor vector limit before preflight", () => {
	const log = new PatchLog(docId);
	for (let i = 0; i < MAX_VECTOR_ENTRIES; i++)
		log.appendRemoteRows([row(1, 65536 + i)]);
	let validated = false;
	expect(() =>
		log.appendRemoteRows([row(1, 65536 + MAX_VECTOR_ENTRIES)], () => {
			validated = true;
		}),
	).toThrow("version vector");
	expect(validated).toBe(false);
	expect(log.size).toBe(MAX_VECTOR_ENTRIES);
	expect(log.vector).toHaveLength(MAX_VECTOR_ENTRIES);
});

test("journal: ascending remote actor batches match the general journal for gaps, forks and duplicates", () => {
	const conflict = row(1);
	conflict.operations[0] = conflict.operations[0]! ^ 1;
	const scenarios: PulsePatchRow[][][] = [
		[Array.from({ length: 100 }, (_, i) => row(i + 1))],
		[
			[row(1), row(2)],
			[row(1), row(2), row(3)],
		],
		[[row(1), row(3)]],
		[[row(1), row(2, 65536, [])]],
		[[{ ...row(1), span: 2 }, row(2)]],
		[
			[
				row(1),
				row(2, 65536, [
					[65536, 2],
					[65537, 2],
				]),
			],
		],
		[[row(1)], [conflict, row(2)]],
		[[row(1)], [row(2), { ...row(3), docId: "other" }]],
	];
	for (const actions of scenarios) {
		const fast = new PatchLog(docId),
			general = new PatchLog(docId);
		for (const incoming of actions) {
			const append = (log: PatchLog, optimized: boolean) => {
				try {
					return optimized
						? log.appendRemoteRows(incoming)
						: log.append(incoming);
				} catch (error) {
					return (error as Error).message;
				}
			};
			expect(append(fast, true)).toEqual(append(general, false));
			expect(fast.vector).toEqual(general.vector);
			expect(fast.pendingCount).toBe(general.pendingCount);
			expect(fast.missing([])).toEqual(general.missing([]));
		}
	}
});

test("journal: ascending actor batches preflight atomically and own every input row", () => {
	const log = new PatchLog(docId),
		incoming = [row(1), row(2), row(3)];
	expect(() =>
		log.appendRemoteRows(incoming, () => {
			throw new Error("reject batch");
		}),
	).toThrow("reject batch");
	expect(log.size).toBe(0);
	expect(log.vector).toEqual([]);
	const expected = structuredClone(incoming);
	expect(log.appendRemoteRows(incoming)).toHaveLength(3);
	for (const item of incoming) {
		item.operations.fill(0);
		item.dependencies.push([99999, 1]);
	}
	expect(log.missing([])).toEqual(expected);
});

test("journal: actor forks, overlaps and invalid numeric ranges reject the whole batch", () => {
	for (const incoming of [
		[row(1), row(2, 65536, [])],
		[{ ...row(1), span: 2 }, row(2)],
		[{ ...row(1), clock: Number.MAX_SAFE_INTEGER }],
		[{ ...row(1), sid: 1 }],
	]) {
		const log = new PatchLog(docId);
		expect(() => log.append(incoming)).toThrow();
		expect(log.size).toBe(0);
		expect(log.vector).toEqual([]);
	}
	const log = new PatchLog(docId);
	log.appendLocalPatch(patch(1), patchToRow);
	expect(() => log.appendLocalPatch(patch(3), patchToRow)).toThrow(
		"contiguous",
	);
	expect(log.vector).toEqual([[65536, 2]]);
});

test("journal: the optimized local path preserves the history row limit", () => {
	const log = new PatchLog(docId);
	for (let clock = 1; clock <= MAX_LOG_ROWS; clock++)
		log.appendLocalPatch(patch(clock), patchToRow);
	expect(() =>
		log.appendLocalPatch(patch(MAX_LOG_ROWS + 1), patchToRow),
	).toThrow("history limit");
	expect(() => log.appendRemoteRows([row(1, 65537)])).toThrow("history limit");
	expect(log.size).toBe(MAX_LOG_ROWS);
	expect(log.vector).toEqual([[65536, MAX_LOG_ROWS + 1]]);
});
