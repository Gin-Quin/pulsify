/**
 * Experimental, deliberately outside the product API. Retains every transaction
 * and its exact canonical v1-envelope/v2-payload row. Direct access to journal
 * internals lets us measure a group-aware receive path before changing protocol,
 * negotiation, connectors, persistence or the public API.
 */
import {
	array,
	object,
	createDecoder,
	createEncoder,
	readVarString,
	readVarUint,
	readVarUint8Array,
	toUint8Array,
	writeFloat64,
	writeVarString,
	writeVarUint,
	writeVarUint8Array,
	type Decoder,
} from "@gin-quin/codec";
import { isDeepStrictEqual } from "node:util";
import { arch, cpus, platform } from "node:os";
import { createReplica, fixture } from "./crdt-adapters.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../packages/pulse/source/index.js";
import { createRuntime } from "../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../packages/pulse/source/pulses/PulseOptions.js";
import {
	type CoreScalar,
	CorePatch,
	ScalarPatch,
} from "../packages/pulse/source/core/operations.js";
import { managedFields } from "../packages/pulse/source/core/model.js";
import {
	rowToPatch,
	type PulsePatchRow,
} from "../packages/pulse/source/connection/PulsePatch.js";
import { encodeCorePatch } from "../packages/pulse/source/core/operations.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../packages/pulse/source/connection/PulseVersionVector.js";
import type { PulseMeta } from "../packages/pulse/source/pulses/PulseMeta.js";
import {
	MAX_LOG_BYTES,
	MAX_LOG_ROWS,
} from "../packages/pulse/source/protocol/PatchLog.js";
import {
	MAX_FRAME_BYTES,
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_VECTOR_ENTRIES,
	MAX_SCHEMA_NODES,
} from "../packages/pulse/source/protocol/limits.js";
import { validateDocId } from "../packages/pulse/source/protocol/validateDocId.js";
import {
	asPulseError,
	PulseError,
} from "../packages/pulse/source/protocol/errors.js";

const definition = definePulse(
	"Comparison",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array(object({ value: "float64", label: "string" })),
	}),
).materialize();
const input = fixture(10);
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
type NativeRow = PulsePatchRow & { patch?: CorePatch };
type JournalState = {
	rows: {
		readonly size: number;
		get(key: string): PulsePatchRow | undefined;
		has(key: string): boolean;
		set(key: string, row: PulsePatchRow): unknown;
	};
	byActor: Map<number, NativeRow[]>;
	frontier: PulseVersionVector;
	budget: { metadata: number; encoded: number };
};
const journal = (meta: PulseMeta) => meta.log as unknown as JournalState;
/** Diagnostic replacement for the redundant composite-key index. Actual actor
 * histories still own every row. Only methods used internally by PatchLog exist.
 */
class ActorRowIndex {
	constructor(
		private readonly actors: Map<number, NativeRow[]>,
		private count: number,
	) {}
	get size() {
		return this.count;
	}
	private find(sid: number, clock: number): PulsePatchRow | undefined {
		const rows = this.actors.get(sid);
		if (!rows?.length || clock > rows[rows.length - 1]!.clock) return undefined;
		let lo = 0,
			hi = rows.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (rows[mid]!.clock < clock) lo = mid + 1;
			else hi = mid;
		}
		return rows[lo]?.clock === clock ? rows[lo] : undefined;
	}
	get(key: string) {
		const colon = key.indexOf(":");
		return this.find(Number(key.slice(0, colon)), Number(key.slice(colon + 1)));
	}
	has(key: string) {
		return this.get(key) !== undefined;
	}
	set(_key: string, row: PulsePatchRow): this {
		check(!this.find(row.sid, row.clock), "Replacing immutable row");
		this.count++;
		return this;
	}
	addValidated(): void {
		this.count++;
	}
}
function useActorIndex(meta: PulseMeta): void {
	const state = journal(meta);
	state.rows = new ActorRowIndex(state.byActor, meta.log.size);
}
const profile = process.argv.includes("--profile");
let phase: Record<string, number> = {};
const mark = (name: string, start: number): number => {
	if (!profile) return 0;
	const now = performance.now();
	phase[name] = (phase[name] ?? 0) + (now - start) * 1000;
	return now;
};
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const uintSize = (value: number) => {
	let size = 1;
	while (value >= 128) {
		size++;
		value = Math.floor(value / 128);
	}
	return size;
};
const stringSize = (value: string) => {
	const length = new TextEncoder().encode(value).length;
	return uintSize(length) + length;
};
const clockAt = (vv: PulseVersionVector, sid: number) =>
	vv.find((entry) => entry[0] === sid)?.[1] ?? 0;
const keyOf = (row: PulsePatchRow) => `${row.sid}:${row.clock}`;
const scalar = (value: unknown): value is CoreScalar =>
	value === null ||
	value === undefined ||
	["string", "number", "boolean"].includes(typeof value);
const same = (a: unknown, b: unknown) =>
	check(isDeepStrictEqual(a, b), "Prototype state/history differs");
function sameDependencies(
	row: PulsePatchRow,
	run: Run,
	offset: number,
): boolean {
	const clock = run.clock + offset;
	if (row.dependencies.length !== run.external.length + (clock > 1 ? 1 : 0))
		return false;
	let externalIndex = 0;
	for (const [sid, time] of row.dependencies) {
		if (sid === run.sid) {
			if (clock === 1 || time !== clock) return false;
		} else {
			const expected = run.external[externalIndex++];
			if (!expected || expected[0] !== sid || expected[1] !== time)
				return false;
		}
	}
	return externalIndex === run.external.length;
}
function utf8Length(value: string): number {
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 128) length++;
		else if (code < 2048) length += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			i + 1 < value.length &&
			value.charCodeAt(i + 1) >= 0xdc00 &&
			value.charCodeAt(i + 1) <= 0xdfff
		) {
			length += 4;
			i++;
		} else length += 3;
	}
	return length;
}
function writeVector(
	encoder: ReturnType<typeof createEncoder>,
	vv: PulseVersionVector,
) {
	writeVarUint(encoder, vv.length);
	for (const [sid, clock] of vv) {
		writeVarUint(encoder, sid);
		writeVarUint(encoder, clock);
	}
}
function readVector(decoder: Decoder): PulseVersionVector {
	const count = readVarUint(decoder);
	check(count <= MAX_VECTOR_ENTRIES, "Vector limit");
	const vv: PulseVersionVector = [];
	for (let i = 0; i < count; i++)
		vv.push([readVarUint(decoder), readVarUint(decoder)]);
	validateVector(vv);
	return vv;
}
type Run = {
	sid: number;
	clock: number;
	count: number;
	lamport: number;
	schema: string;
	target: string;
	field: string | number;
	layout: number;
	external: PulseVersionVector;
	payloads: Uint8Array[];
	source?: Uint8Array;
	spans?: Uint32Array;
};
function dependencies(run: Run, offset: number): PulseVersionVector {
	const vv = run.external.slice(),
		clock = run.clock + offset;
	if (clock > 1) {
		const index = vv.findIndex(([sid]) => sid > run.sid);
		vv.splice(index < 0 ? vv.length : index, 0, [run.sid, clock]);
	}
	return vv;
}
function operationBytes(run: Run, offset: number): Uint8Array {
	const encoder = createEncoder();
	writeVarUint(encoder, 2);
	writeVarUint(encoder, run.lamport + offset);
	writeVarString(encoder, run.schema);
	writeVarUint(encoder, 1);
	writeVarUint(encoder, 1);
	writeVarString(encoder, run.target);
	writeVarUint(encoder, typeof run.field === "string" ? 0 : 1);
	if (typeof run.field === "string") writeVarString(encoder, run.field);
	else writeVarUint(encoder, run.field);
	writeVarUint(encoder, run.layout);
	const payload =
		run.payloads[offset] ??
		run.source!.subarray(run.spans![offset * 2], run.spans![offset * 2 + 1]);
	writeVarUint8Array(encoder, payload);
	writeVarUint(encoder, 0);
	writeVarUint(encoder, 0);
	return toUint8Array(encoder);
}
class RunRow implements PulsePatchRow {
	readonly docId: string;
	readonly sid: number;
	readonly clock: number;
	readonly span = 1;
	private cachedDependencies: PulseVersionVector | undefined;
	private cached: Uint8Array | undefined;
	constructor(
		docId: string,
		readonly run: Run,
		readonly offset: number,
	) {
		this.docId = docId;
		this.sid = run.sid;
		this.clock = run.clock + offset;
	}
	get dependencies(): PulseVersionVector {
		return (this.cachedDependencies ??= dependencies(this.run, this.offset));
	}
	get operations() {
		return (this.cached ??= operationBytes(this.run, this.offset));
	}
}
function layoutFor(meta: PulseMeta, target: string, field: string | number) {
	check(
		meta.model.maxVersion === 1 && meta.definition.migrations.length === 0,
		"Prototype excludes migrations",
	);
	const node = meta.model.index.get(target);
	check(node, "Unknown target");
	const key = meta.model.fieldKey(node, field);
	check(!managedFields.has(key), "Prototype excludes managed fields");
	const entry = node.layout?.fieldsByKey.get(key),
		layout = entry?.layout;
	check(
		!node.layout?.constant &&
			entry &&
			!entry.constant &&
			!entry.richText &&
			layout &&
			!layout.constant &&
			!layout.richText,
		"Prototype excludes constants/rich text",
	);
	check(
		layout.kind === "string" || layout.kind === "float64",
		"Prototype supports string/float64 columns only",
	);
	return layout;
}
function validateScalarRun(
	meta: PulseMeta,
	run: Run,
	values: readonly CoreScalar[],
): void {
	const layout = layoutFor(meta, run.target, run.field);
	check(run.schema === meta.model.schemaId, "Schema mismatch");
	const node = meta.model.index.get(run.target)!;
	check(node.kind === "object", "Expected object target");
	// Every row has the same source node and fixed external VV. Its own clock
	// increases, so coverage of the first row proves coverage for every row.
	const actor = node.initialStamp[1],
		created = node.initialStamp[2];
	const have =
		actor === run.sid
			? run.clock > 1
				? run.clock
				: 0
			: clockAt(run.external, actor);
	check(have > created, "Operation reference is not causally covered");
	for (const value of values) {
		check(scalar(value), "Non-scalar run value");
		layout.assert(value);
	}
}
function differentialValidation(meta: PulseMeta): void {
	const accepted = (fn: () => void) => {
		try {
			fn();
			return true;
		} catch {
			return false;
		}
	};
	for (const [node, key, lists] of [
		[
			meta.model.root!,
			"title",
			[
				["", "é🌍", "e\u0301"],
				["\ud800", "okay"],
				[1, "okay"],
				[undefined, "okay"],
				[null, "okay"],
			],
		],
		[
			meta.model.root!.children.get("nested")!,
			"count",
			[
				[0, -0, 1.25, Number.MAX_VALUE],
				[NaN, 1],
				[Infinity, 1],
				["bad", 1],
				[true, 1],
				[null, 1],
				[undefined, 1],
			],
		],
	] as const) {
		for (const values of lists) {
			const base: Run = {
				sid: 65537,
				clock: 1,
				count: values.length,
				lamport: 2,
				schema: meta.model.schemaId,
				target: node.id,
				field: meta.model.field(node, key),
				layout: 0,
				external: [[65536, 2]],
				payloads: [],
			};
			for (const run of [
				base,
				{ ...base, schema: "mismatched-schema" },
				{ ...base, target: "65536:1:99999" },
				{ ...base, field: "absent" },
				{ ...base, external: [[65536, 1]] as PulseVersionVector },
				{ ...base, sid: 65536, clock: 2, external: [] },
			]) {
				const patches = values.map(
					(value, i) =>
						new CorePatch(run.sid, run.clock + i, run.lamport + i, run.schema, [
							{
								kind: 1,
								target: run.target,
								field: run.field,
								value: { value, constants: [], texts: [] },
							},
						]),
				);
				const deps = new Map(
					patches.map((patch, i) => [patch, dependencies(run, i)]),
				);
				same(
					accepted(() => validateScalarRun(meta, run, values)),
					accepted(() => meta.model.validate(patches, deps)),
				);
			}
		}
	}
}
function exportRun(meta: PulseMeta, vv: PulseVersionVector): Uint8Array {
	const start = profile ? performance.now() : 0;
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	validateVector(vv);
	const rows: NativeRow[] = [];
	for (const [sid, history] of journal(meta).byActor) {
		const clock = clockAt(vv, sid);
		for (const row of history) if (row.clock >= clock) rows.push(row);
	}
	check(
		rows.length > 0 && rows.length <= MAX_MESSAGE_ROWS,
		"Prototype needs one nonempty scalar run",
	);
	let run: Run | undefined;
	let layout: ReturnType<typeof layoutFor> | undefined;
	const encoder = createEncoder(
		Math.min(MAX_FRAME_BYTES, 256 + rows.length * 16),
	);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		const patch =
			row.patch ??
			rowToPatch(row, (schema) => meta.model.decodeEncoding(schema));
		let target: string, field: string | number, value: unknown;
		if (patch instanceof ScalarPatch) {
			target = patch.target;
			field = patch.field;
			value = patch.value;
		} else {
			const op = patch.ops.length === 1 ? patch.ops[0] : undefined;
			check(
				op?.kind === 1 && !op.value.constants.length && !op.value.texts.length,
				"Prototype needs marker-free single writes",
			);
			target = op.target;
			field = op.field;
			value = op.value.value;
		}
		check(scalar(value), "Prototype needs scalar values");
		if (!run) {
			layout = layoutFor(meta, target, field);
			run = {
				sid: row.sid,
				clock: row.clock,
				count: rows.length,
				lamport: patch.lamport,
				schema: patch.schema,
				target,
				field,
				layout: layout.id + 2,
				external: row.dependencies.filter(([sid]) => sid !== row.sid),
				payloads: [],
			};
			// Experimental envelope version 2; not accepted by production endpoints.
			writeVarUint(encoder, 2);
			writeVarUint(encoder, 2);
			writeVarUint(encoder, 4);
			writeVarString(encoder, meta.id);
			writeVarUint(encoder, 0);
			writeVector(encoder, meta.log.vector);
			writeVarUint(encoder, run.sid);
			writeVarUint(encoder, run.clock);
			writeVarUint(encoder, run.count);
			writeVarUint(encoder, run.lamport);
			writeVarString(encoder, run.schema);
			writeVarString(encoder, run.target);
			writeVarUint(encoder, typeof run.field === "string" ? 0 : 1);
			if (typeof run.field === "string") writeVarString(encoder, run.field);
			else writeVarUint(encoder, run.field);
			writeVarUint(encoder, run.layout);
			writeVector(encoder, run.external);
		}
		check(
			row.sid === run.sid &&
				row.clock === run.clock + i &&
				row.span === 1 &&
				patch.lamport === run.lamport + i &&
				patch.schema === run.schema &&
				target === run.target &&
				field === run.field,
			"Noncontiguous prototype run",
		);
		check(sameDependencies(row, run, i), "Noncanonical run dependencies");
		if (layout!.kind === "float64") {
			writeVarUint(encoder, 8);
			writeFloat64(encoder, value as number);
		} else {
			const length = utf8Length(value as string);
			writeVarUint(encoder, uintSize(length) + length);
			writeVarString(encoder, value as string);
		}
	}
	check(run, "Empty prototype run");
	const bytes = toUint8Array(encoder);
	check(bytes.length <= MAX_FRAME_BYTES, "Frame limit");
	mark("exports", start);
	return bytes;
}
function importRun(
	meta: PulseMeta,
	bytes: Uint8Array,
	foldApplication = false,
	cursorValidation = false,
	groupValidation = false,
): void {
	let start = profile ? performance.now() : 0;
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	check(bytes.length <= MAX_FRAME_BYTES, "Frame limit");
	const owned = new Uint8Array(bytes),
		decoder = createDecoder(owned);
	check(
		readVarUint(decoder) === 2 &&
			readVarUint(decoder) === 2 &&
			readVarUint(decoder) === 4,
		"Prototype envelope version",
	);
	const docId = readVarString(decoder);
	validateDocId(docId);
	check(
		docId === meta.id && readVarUint(decoder) === 0,
		"Document/request mismatch",
	);
	const advertised = readVector(decoder);
	const sid = readVarUint(decoder),
		clock = readVarUint(decoder),
		count = readVarUint(decoder),
		lamport = readVarUint(decoder);
	check(
		count > 0 &&
			count <= MAX_MESSAGE_ROWS &&
			meta.log.size + count <= MAX_LOG_ROWS,
		"Expanded row count limit",
	);
	check(
		Number.isSafeInteger(sid) &&
			sid >= 65536 &&
			clock >= 1 &&
			lamport >= 1 &&
			Number.isSafeInteger(clock + count) &&
			Number.isSafeInteger(lamport + count),
		"Invalid run range",
	);
	const schema = readVarString(decoder),
		target = readVarString(decoder),
		tag = readVarUint(decoder);
	check(tag <= 1, "Invalid field tag");
	const field = tag === 0 ? readVarString(decoder) : readVarUint(decoder),
		layoutId = readVarUint(decoder),
		external = readVector(decoder);
	check(
		9 + advertised.length * 3 + count * (7 + 3 * (external.length + 1)) <=
			MAX_SCHEMA_NODES,
		"Expanded schema node limit",
	);
	check(
		!external.some(([actor]) => actor === sid),
		"Own actor in external dependencies",
	);
	check(schema === meta.model.schemaId, "Schema mismatch");
	const layout = layoutFor(meta, target, field);
	check(layoutId === layout.id + 2, "Layout mismatch");
	const state = journal(meta),
		actor = state.byActor.get(sid),
		previous = actor?.at(-1);
	check(
		clock === (previous ? previous.clock + previous.span : 1),
		"Prototype requires contiguous new delivery (no gaps/duplicates)",
	);
	for (const [actorId, required] of external)
		check(
			clockAt(state.frontier, actorId) >= required,
			"Uncovered external dependency",
		);
	check(
		clockAt(state.frontier, sid) === (clock === 1 ? 0 : clock),
		"Actor fork",
	);
	check(
		clockAt(state.frontier, sid) || state.frontier.length < MAX_VECTOR_ENTRIES,
		"Actor vector limit",
	);
	const valueStart = decoder.pos;
	const fixedBytes =
		1 +
		stringSize(schema) +
		2 +
		stringSize(target) +
		1 +
		(typeof field === "string" ? stringSize(field) : uintSize(field)) +
		uintSize(layoutId) +
		2;
	let expandedBytes = 0;
	// Scan and reject expansion bombs before allocating a per-row array/object.
	for (let i = 0; i < count; i++) {
		const length = readVarUint(decoder);
		check(length <= decoder.arr.length - decoder.pos, "Truncated column");
		decoder.pos += length;
		const operationSize =
			fixedBytes + uintSize(lamport + i) + uintSize(length) + length;
		check(operationSize <= MAX_PATCH_BYTES, "Expanded patch size limit");
		expandedBytes +=
			operationSize +
			(external.length + (clock + i > 1 ? 1 : 0)) * 16 +
			docId.length * 2 +
			40;
		check(
			state.budget.metadata + state.budget.encoded + expandedBytes <=
				MAX_LOG_BYTES,
			"Expanded history byte limit",
		);
	}
	check(decoder.pos === owned.length, "Trailing bytes");
	decoder.pos = valueStart;
	start = mark("header-and-size-scan", start);
	const run: Run = {
		sid,
		clock,
		count,
		lamport,
		schema,
		target,
		field,
		layout: layoutId,
		external,
		payloads: [],
	};
	if (groupValidation) {
		run.source = owned;
		run.spans = new Uint32Array(count * 2);
	}
	const patches: CorePatch[] = [],
		deps = new Map<CorePatch, PulseVersionVector>(),
		incoming: RunRow[] = [],
		values: CoreScalar[] = [];
	for (let i = 0; i < count; i++) {
		let value: unknown;
		if (groupValidation) {
			// Same typed primitive codec, without allocating a Decoder/DataView for
			// every scalar or a byte view for every retained value. The entire frame
			// is owned; each original payload range remains individually addressable.
			const length = readVarUint(decoder),
				valueDecoder = decoder;
			const begin = valueDecoder.pos,
				end = begin + length;
			run.spans![i * 2] = begin;
			run.spans![i * 2 + 1] = end;
			if (layout.kind === "float64") {
				check(length === 8, "Invalid float64 payload length");
				value = valueDecoder.view.getFloat64(begin, true);
				valueDecoder.pos = end;
			} else {
				valueDecoder.pos = begin;
				value = readVarString(valueDecoder);
				check(valueDecoder.pos === end, "Trailing value bytes");
			}
		} else {
			const payload = readVarUint8Array(decoder);
			run.payloads.push(payload);
			value = meta.model.compiled!.decode(layout.id, payload);
		}
		check(scalar(value), "Non-scalar run value");
		values.push(value);
		const patch =
			cursorValidation || groupValidation
				? undefined
				: new CorePatch(sid, clock + i, lamport + i, schema, [
						{
							kind: 1,
							target,
							field,
							value: { value, constants: [], texts: [] },
						},
					]);
		if (patch) patches.push(patch);
		const row = new RunRow(docId, run, i);
		incoming.push(row);
		if (patch) deps.set(patch, row.dependencies);
	}
	start = mark("decode-and-stage", start);
	let lastPatch: CorePatch;
	if (groupValidation) {
		check(foldApplication, "Group prototype requires folded application");
		validateScalarRun(meta, run, values);
		lastPatch = new CorePatch(
			sid,
			clock + count - 1,
			lamport + count - 1,
			schema,
			[
				{
					kind: 1,
					target,
					field,
					value: { value: values[count - 1], constants: [], texts: [] },
				},
			],
		);
	} else if (cursorValidation) {
		check(foldApplication, "Cursor prototype requires folded application");
		const op = {
			kind: 1 as const,
			target,
			field,
			value: { value: values[0], constants: [], texts: [] },
		};
		const cursor = new CorePatch(sid, clock, lamport, schema, [op]);
		// Diagnostic-only mutable cursor. The real validateSingle guard still runs
		// for EVERY row/value; homogeneous primitive writes cannot stage nodes.
		const mutable = cursor as unknown as { clock: number; lamport: number };
		for (let i = 0; i < count; i++) {
			mutable.clock = clock + i;
			mutable.lamport = lamport + i;
			op.value.value = values[i];
			meta.model.validateSingle(cursor, incoming[i]!.dependencies);
		}
		lastPatch = cursor;
	} else {
		meta.model.validate(patches, deps);
		lastPatch = patches[patches.length - 1]!;
	}
	start = mark("preflight", start);
	const history = actor ?? [];
	const actorIndex =
		state.rows instanceof ActorRowIndex ? state.rows : undefined;
	for (const row of incoming) {
		// The contiguous range check above proved every ID new before preflight.
		if (actorIndex) actorIndex.addValidated();
		else state.rows.set(keyOf(row), row);
		history.push(row);
	}
	if (!actor) state.byActor.set(sid, history);
	const frontier = state.frontier.filter(([actorId]) => actorId !== sid);
	frontier.push([sid, clock + count]);
	frontier.sort((a, b) => a[0] - b[0]);
	state.frontier = frontier;
	state.budget.metadata += expandedBytes;
	start = mark("journal-commit", start);
	if (foldApplication) meta.model.apply(lastPatch);
	else for (const patch of patches) meta.model.apply(patch);
	meta.loaded = !!meta.model.root;
	// layoutFor proved maxVersion=1/no migrators. Preserve the actual runtime's
	// loaded-state and notification boundary, including listener error handling.
	if (meta.loaded && meta.connections.length && meta.status === "synced")
		meta.status = "ready";
	const listeners = [...meta.listeners],
		rowListeners = [...meta.rowListeners];
	for (const listener of [...listeners, ...rowListeners]) {
		try {
			listener();
		} catch (error) {
			meta.report(asPulseError(error));
		}
	}
	mark("application-and-notify", start);
}

type Prepared = {
	run(): void;
	verify(): void;
	dispose(): void;
	bytes(): number;
};
function ordinary(engine: "pulsify" | "json-joy"): Prepared {
	const a = createReplica(engine, input),
		b = createReplica(engine, undefined, 65537);
	b.importFull(a.exportFull());
	for (let i = 1; i <= 100; i++) {
		a.setCount(i);
		b.setTitle(`offline-${i}`);
	}
	let bytes = 0,
		sa: unknown,
		sb: unknown;
	return {
		run() {
			const va = a.checkpoint(),
				vb = b.checkpoint();
			try {
				const toA = b.exportSince(va),
					toB = a.exportSince(vb);
				bytes = toA.bytes + toB.bytes;
				a.importDelta(toA);
				b.importDelta(toB);
				sa = a.snapshot();
				sb = b.snapshot();
			} finally {
				va.dispose();
				vb.dispose();
			}
		},
		verify() {
			same(sa, sb);
		},
		dispose() {
			a.dispose();
			b.dispose();
		},
		bytes: () => bytes,
	};
}
function prototype(
	foldApplication = false,
	cursorValidation = false,
	groupValidation = false,
	actorIndex = false,
): Prepared {
	const a = createPulse(
		definition,
		{
			id: input.id,
			title: input.title,
			nested: input.nested,
			items: input.items,
		},
		options(65536),
	);
	const b = createRuntime(definition, input.id, options(65537));
	const ma = getPulseMeta(a),
		mb = getPulseMeta(b);
	mb.applyRows(ma.log.missing([]));
	for (let i = 1; i <= 100; i++) {
		a.nested.count = i;
		b["title"] = `offline-${i}`;
	}
	if (actorIndex) {
		useActorIndex(ma);
		useActorIndex(mb);
	}
	let sa: unknown,
		sb: unknown,
		bytes = 0;
	return {
		run() {
			const vectorStart = profile ? performance.now() : 0;
			const va = ma.log.vector,
				vb = mb.log.vector;
			mark("vectors", vectorStart);
			const toA = exportRun(mb, va),
				toB = exportRun(ma, vb);
			bytes = toA.length + toB.length;
			importRun(ma, toA, foldApplication, cursorValidation, groupValidation);
			importRun(mb, toB, foldApplication, cursorValidation, groupValidation);
			const snapshotStart = profile ? performance.now() : 0;
			sa = snapshotPulse(a);
			sb = snapshotPulse(b);
			mark("snapshots", snapshotStart);
		},
		verify() {
			same(sa, sb);
			check(
				(sa as typeof input).nested.count === 100 &&
					(sa as typeof input).title === "offline-100",
				"Lost edits",
			);
			check(
				ma.log.size === 201 && mb.log.size === 201,
				"Every original transaction must remain",
			);
			same(ma.log.vector, mb.log.vector);
			const rowsA = ma.log.missing([]),
				rowsB = mb.log.missing([]);
			const sort = (rows: PulsePatchRow[]) =>
				rows.sort((x, y) => x.sid - y.sid || x.clock - y.clock);
			same(sort(rowsA), sort(rowsB));
			// Every prefix frontier, not just the full vector, returns identical bytes.
			for (const sid of [65536, 65537])
				for (let clock = 1; clock <= (sid === 65536 ? 102 : 101); clock++) {
					const vv: PulseVersionVector = [[sid, clock]];
					same(sort(ma.log.missing(vv)), sort(mb.log.missing(vv)));
				}
			const replay = createRuntime(definition, input.id, options(65538));
			try {
				getPulseMeta(replay).applyRows(rowsA);
				same(snapshotPulse(replay), sa);
			} finally {
				destroyPulse(replay);
			}
		},
		dispose() {
			destroyPulse(a);
			destroyPulse(b);
		},
		bytes: () => bytes,
	};
}
function selfTest(): void {
	for (const [fold, cursor, group, actorIndex] of [
		[false, false, false, false],
		[true, false, false, false],
		[true, true, false, false],
		[true, false, true, false],
		[true, false, true, true],
	] as const) {
		const a = createPulse(
			definition,
			{
				id: input.id,
				title: input.title,
				nested: input.nested,
				items: input.items,
			},
			options(65536),
		);
		const b = createRuntime(definition, input.id, options(65537));
		const ma = getPulseMeta(a),
			mb = getPulseMeta(b);
		try {
			mb.applyRows(ma.log.missing([]));
			for (let i = 1; i <= 100; i++) {
				a.nested.count = i;
				b["title"] = `offline-${i}`;
			}
			if (actorIndex) {
				useActorIndex(ma);
				useActorIndex(mb);
			}
			if (group) differentialValidation(ma);
			// A newer competing register stamp must win over the WHOLE incoming run.
			b["nested"].count = 999;
			const frame = exportRun(ma, mb.log.vector),
				scan = createDecoder(frame);
			readVarUint(scan);
			readVarUint(scan);
			readVarUint(scan);
			readVarString(scan);
			readVarUint(scan);
			readVector(scan);
			readVarUint(scan);
			const clockOffset = scan.pos;
			readVarUint(scan);
			const countOffset = scan.pos;
			readVarUint(scan);
			readVarUint(scan);
			readVarString(scan);
			readVarString(scan);
			const tag = readVarUint(scan);
			if (tag === 0) readVarString(scan);
			else readVarUint(scan);
			readVarUint(scan);
			const externalOffset = scan.pos;
			readVector(scan);
			const externalEnd = scan.pos;
			readVarUint(scan);
			const firstPayload = scan.pos;
			const reject = (bytes: Uint8Array, message?: string) => {
				const snapshot = snapshotPulse(b),
					vector = mb.log.vector,
					size = mb.log.size,
					budget = { ...journal(mb).budget };
				let error: unknown;
				try {
					importRun(mb, bytes, fold, cursor, group);
				} catch (caught) {
					error = caught;
				}
				check(error, "Malformed prototype run unexpectedly accepted");
				if (message)
					check(
						error instanceof Error && error.message.includes(message),
						"Wrong rejection boundary",
					);
				same(snapshotPulse(b), snapshot);
				same(mb.log.vector, vector);
				same(mb.log.size, size);
				same(journal(mb).budget, budget);
			};
			const invalidValue = frame.slice();
			new DataView(invalidValue.buffer).setFloat64(firstPayload, NaN, true);
			reject(invalidValue);
			const gap = frame.slice();
			gap[clockOffset] = 3;
			reject(gap);
			const tooMany = new Uint8Array(frame.length + 1);
			tooMany.set(frame.subarray(0, countOffset));
			tooMany.set([0x81, 0x20], countOffset);
			tooMany.set(frame.subarray(countOffset + 1), countOffset + 2);
			reject(tooMany);
			const wide = createEncoder();
			writeVector(
				wide,
				Array.from({ length: 1000 }, (_, i): [number, number] => [
					70000 + i,
					1,
				]),
			);
			const wideVector = toUint8Array(wide),
				wideFrame = new Uint8Array(
					frame.length - (externalEnd - externalOffset) + wideVector.length,
				);
			wideFrame.set(frame.subarray(0, externalOffset));
			wideFrame.set(wideVector, externalOffset);
			wideFrame.set(
				frame.subarray(externalEnd),
				externalOffset + wideVector.length,
			);
			reject(wideFrame, "Expanded schema node limit");
			reject(frame.subarray(0, frame.length - 1));
			reject(new Uint8Array([...frame, 0]));
			const budget = journal(mb).budget.metadata;
			journal(mb).budget.metadata = MAX_LOG_BYTES - 1;
			reject(frame);
			journal(mb).budget.metadata = budget;
			let notifications = 0;
			mb.listeners.add(() => {
				throw new Error("Listener failure");
			});
			mb.rowListeners.add(() => {
				notifications++;
			});
			const buffer = Buffer.from(frame);
			importRun(mb, buffer, fold, cursor, group);
			buffer.fill(0);
			check(
				mb.loaded && notifications === 1 && mb.lastError,
				"Runtime guards/notifications changed",
			);
			check(
				b["nested"].count === 999 && mb.log.size === 202,
				"Fold lost newer competing stamp or history",
			);
			const beforeMaterialization = { ...journal(mb).budget };
			for (const row of journal(mb).byActor.get(65536)!)
				if (row instanceof RunRow) void row.operations;
			same(journal(mb).budget, beforeMaterialization);
			const vv: PulseVersionVector = [[65537, 102]];
			same(ma.log.missing(vv), mb.log.missing(vv));
			if (actorIndex) {
				const legacy = ma.log.missing(vv),
					size = mb.log.size;
				mb.applyRows(legacy);
				same(mb.log.size, size);
				const original = legacy.find((row) => row.clock === 2)!;
				const changed = rowToPatch(original, (schema) =>
					ma.model.decodeEncoding(schema),
				);
				const op = changed.ops[0]!;
				check(op.kind === 1, "Expected scalar conflict fixture");
				op.value.value = 9999;
				let conflict: unknown;
				try {
					mb.applyRows([
						{
							...original,
							operations: encodeCorePatch(changed, ma.model.encoding),
						},
					]);
				} catch (error) {
					conflict = error;
				}
				check(conflict, "Actor index lost immutable duplicate conflict");
				same(mb.log.size, size);
			}
			reject(frame); // Production will need normal duplicate/fork/gap fallback.
			b["title"] = "after-merge";
			check(
				clockAt(journal(mb).byActor.get(65537)!.at(-1)!.dependencies, 65536) ===
					102,
				"Future local write lost imported causal frontier",
			);
		} finally {
			destroyPulse(a);
			destroyPulse(b);
		}
	}
}
selfTest();
const warmSuite = process.argv.includes("--warm-suite");
let suiteWarmupReport: unknown;
if (warmSuite) {
	// Run the unchanged official suite first, in THIS process, preserving every
	// original scenario and metric. Its report goes to /tmp, never the saved report.
	const previousArgv = process.argv;
	try {
		process.argv = [
			previousArgv[0]!,
			previousArgv[1]!,
			"--output",
			"/tmp/pulsify-scalar-run-warm.json",
			"--markdown",
			"/tmp/pulsify-scalar-run-warm.md",
		];
		await import("./crdt-comparison.js");
		suiteWarmupReport = await Bun.file(
			"/tmp/pulsify-scalar-run-warm.json",
		).json();
	} finally {
		process.argv = previousArgv;
	}
}
const values = new Map<
	string,
	{ times: number[]; bytes: number[]; phases: Record<string, number>[] }
>(
	[
		"pulsify",
		"scalar-run-prototype",
		"scalar-run-fold-prototype",
		"scalar-run-cursor-prototype",
		"scalar-run-group-validation-prototype",
		"scalar-run-actor-index-prototype",
		"json-joy",
	].map((name) => [name, { times: [], bytes: [], phases: [] }]),
);
let seed = 0x51f15e;
for (let sample = -5; sample < 25; sample++) {
	const participants = [...values.keys()];
	for (let i = participants.length - 1; i > 0; i--) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const j = seed % (i + 1);
		[participants[i], participants[j]] = [participants[j]!, participants[i]!];
	}
	for (const name of participants) {
		Bun.gc(true);
		const state = name.startsWith("scalar-run")
			? prototype(
					name.includes("fold") ||
						name.includes("cursor") ||
						name.includes("group-validation") ||
						name.includes("actor-index"),
					name.includes("cursor"),
					name.includes("group-validation") || name.includes("actor-index"),
					name.includes("actor-index"),
				)
			: ordinary(name as "pulsify" | "json-joy");
		try {
			Bun.gc(true);
			phase = {};
			const start = performance.now();
			state.run();
			const time = (performance.now() - start) * 1000;
			state.verify();
			if (sample >= 0) {
				values.get(name)!.times.push(time);
				values.get(name)!.bytes.push(state.bytes());
				values.get(name)!.phases.push(phase);
			}
		} finally {
			state.dispose();
		}
	}
}
const results = [...values].map(([participant, value]) => {
	const sorted = [...value.times].sort((a, b) => a - b);
	return {
		participant,
		medianUs: sorted[12],
		p95Us: sorted[23],
		bytes: value.bytes[0],
		samplesUs: value.times,
		...(profile
			? {
					phaseMediansUs: Object.fromEntries(
						Object.keys(value.phases[0]!).map((key) => [
							key,
							value.phases
								.map((sample) => sample[key] ?? 0)
								.sort((a, b) => a - b)[12],
						]),
					),
				}
			: {}),
	};
});
const report = {
	experimentalPrototype: true,
	instrumented: profile,
	warmSuite,
	selfTestsPassed: true,
	generatedAt: new Date().toISOString(),
	runtime: Bun.version,
	commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
	environment: { cpu: cpus()[0]?.model, arch: arch(), platform: platform() },
	sourceSha256: new Bun.CryptoHasher("sha256")
		.update(await Bun.file(new URL(import.meta.url)).arrayBuffer())
		.digest("hex"),
	scenario: "offline-merge/100-per-peer",
	parameters: {
		samples: 25,
		warmup: 5,
		iterations: 1,
		nativeTransactionsPerPeer: 100,
		fixtureVersion: 1,
	},
	limitations: [
		"White-box journal commit; not a product API or negotiated protocol",
		"Only typed string/float64 columns; no migrations, managed fields, constant/rich-text captures",
		"Contiguous fresh delivery only; duplicates/gaps use no optimized path yet",
	],
	results,
	...(warmSuite ? { suiteWarmupReport } : {}),
};
if (process.argv[2])
	await Bun.write(process.argv[2]!, JSON.stringify(report, null, 2) + "\n");
console.log(
	JSON.stringify(
		results.map(({ samplesUs, ...result }) => result),
		null,
		2,
	),
);
