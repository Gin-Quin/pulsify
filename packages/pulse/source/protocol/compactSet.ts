import {
	createDecoder,
	createEncoder,
	toUint8Array,
	writeFloat64,
	writeUint8Array,
	writeVarString,
	writeVarUint,
	type Decoder,
} from "@gin-quin/codec";
import type { PulseMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import type { CoreModel } from "../core/model.js";
import type { CoreField, CoreScalar } from "../core/operations.js";
import { PulseError } from "./errors.js";
import {
	MAX_FRAME_BYTES,
	MAX_PATCH_BYTES,
	MAX_VECTOR_ENTRIES,
} from "./limits.js";
import { nativePatchOf } from "./PatchLog.js";
import {
	requireRun,
	runOperationSize,
	runRows,
	scalarEntryOf,
	text,
	uint,
	vector,
	writeVector,
	type ScalarRun,
} from "./scalarRuns.js";
import { validateDocId } from "./validateDocId.js";
import { OPERATIONS_VERSION } from "./versions.js";

/**
 * Envelope 4: one scalar register write between two pulses of one document.
 * It leaves out what the receiver already holds. The schema identity and the
 * value layout are those of the row that created the target, which a
 * single-version receiver knows as its own. The receiver rebuilds the exact
 * original row, so journals and storage never see this format.
 */
export const COMPACT_VERSION = 4;
const REQUEST = 1,
	VECTOR = 2,
	EXTERNAL = 4,
	NAMED = 8,
	INTEGER = 16;
type Model = Pick<CoreModel, "schemaId" | "scalarColumn" | "index">;
type Update = Extract<PulseMessage, { kind: 4 }>;

const frame = createEncoder(256);
const scratch = new DataView(new ArrayBuffer(8));
const scratchBytes = new Uint8Array(scratch.buffer);
const isIntegerValue = (value: number) =>
	Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
/** Eight value bytes holding a small integer as a float64 travel as a varint. */
function integerAt(bytes: Uint8Array, at: number): number | undefined {
	for (let i = 0; i < 8; i++) scratchBytes[i] = bytes[at + i]!;
	const value = scratch.getFloat64(0, true);
	return isIntegerValue(value) ? value : undefined;
}
/** Node IDs are `actor:clock:serial`; anything else keeps the exact envelope. */
function nodeId(target: string): [number, number, number] | undefined {
	const parts = target.split(":");
	if (parts.length !== 3) return;
	const id = parts.map(Number) as [number, number, number];
	return id.every((n, i) => Number.isSafeInteger(n) && String(n) === parts[i])
		? id
		: undefined;
}
/** The sender vector is implied when it is this row's dependencies plus the row. */
function derivedVector(
	sid: number,
	clock: number,
	external: PulseVersionVector,
): PulseVersionVector {
	const vv: PulseVersionVector = [];
	let placed = false;
	for (let i = 0; i < external.length; i++) {
		const actor = external[i]![0];
		requireRun(actor !== sid, "Invalid compact dependencies");
		if (!placed && actor > sid) placed = !!vv.push([sid, clock + 1]);
		vv.push([actor, external[i]![1]]);
	}
	if (!placed) vv.push([sid, clock + 1]);
	return vv;
}
// ponytail: one remembered document ID; interleaved documents decode theirs each time.
let lastDocId: { bytes: Uint8Array; value: string } | undefined;
function documentId(d: Decoder): string {
	const start = d.pos,
		length = uint(d),
		known = lastDocId;
	if (known?.bytes.length === length && d.pos + length <= d.arr.length) {
		let i = 0;
		while (i < length && d.arr[d.pos + i] === known.bytes[i]) i++;
		if (i === length) {
			d.pos += length;
			return known.value;
		}
	}
	d.pos = start;
	const value = text(d);
	validateDocId(value);
	lastDocId = { bytes: d.arr.slice(d.pos - length, d.pos), value };
	return value;
}
function sameVector(a: PulseVersionVector, b: PulseVersionVector): boolean {
	return (
		a.length === b.length &&
		a.every(([sid, clock], i) => sid === b[i]![0] && clock === b[i]![1])
	);
}

/** Returns nothing for any write this envelope cannot express: keep exact rows then. */
export function encodeCompactSet(
	message: Update,
	row: PulsePatchRow,
	model: Model,
): Uint8Array<ArrayBuffer> | undefined {
	const patch = nativePatchOf(row),
		entry = patch ? undefined : scalarEntryOf(row),
		source = patch ?? entry?.run;
	if (!source || row.span !== 1) return;
	const column = model.scalarColumn(source.target, source.field);
	if (
		!column ||
		source.schema !== model.schemaId ||
		(entry && entry.run.layout !== column.id + 2)
	)
		return;
	const offset =
		(patch ? patch.lamport : entry!.run.lamport + entry!.offset) - row.clock;
	const target = nodeId(source.target);
	let own = 0;
	const external: PulseVersionVector = [];
	for (const dependency of row.dependencies)
		if (dependency[0] === row.sid) own = dependency[1];
		else external.push(dependency);
	const actor = !target
		? -1
		: target[0] === row.sid
			? 0
			: external.findIndex(([sid]) => sid === target[0]) + 1;
	if (
		!target ||
		(!actor && target[0] !== row.sid) ||
		offset < 0 ||
		own !== (row.clock > 1 ? row.clock : 0)
	)
		return;
	const named = typeof source.field === "string";
	let flags =
		(message.requestId ? REQUEST : 0) |
		(sameVector(message.vv, derivedVector(row.sid, row.clock, external))
			? 0
			: VECTOR) |
		(external.length ? EXTERNAL : 0) |
		(named ? NAMED : 0);
	const e = frame;
	e.pos = 0;
	writeVarUint(e, COMPACT_VERSION);
	writeVarUint(e, OPERATIONS_VERSION);
	writeVarUint(e, 0);
	writeVarString(e, message.docId);
	if (flags & REQUEST) writeVarUint(e, message.requestId);
	writeVarUint(e, row.sid);
	writeVarUint(e, row.clock);
	writeVarUint(e, offset);
	if (flags & EXTERNAL) writeVector(e, external);
	if (flags & VECTOR) writeVector(e, message.vv);
	writeVarUint(e, actor);
	writeVarUint(e, target[1]);
	writeVarUint(e, target[2]);
	if (named) writeVarString(e, source.field as string);
	else writeVarUint(e, source.field as number);
	const start = e.pos;
	const value: CoreScalar | Uint8Array = patch
		? patch.value
		: entry!.run.source.subarray(
				entry!.run.spans[entry!.offset * 2],
				entry!.run.spans[entry!.offset * 2 + 1],
			);
	if (typeof value === "number" && column.kind === "float64") {
		if (isIntegerValue(value)) {
			flags |= INTEGER;
			writeVarUint(e, value);
		} else writeFloat64(e, value);
	} else {
		if (typeof value === "string" && column.kind === "string")
			writeVarString(e, value);
		else if (value instanceof Uint8Array) writeUint8Array(e, value);
		else return;
		const integer =
			e.pos - start === 8 ? integerAt(e.buffer, start) : undefined;
		if (integer !== undefined) {
			flags |= INTEGER;
			e.pos = start;
			writeVarUint(e, integer);
		}
	}
	if (e.pos === start || e.pos > MAX_FRAME_BYTES) return;
	e.buffer[2] = flags;
	return toUint8Array(e);
}

/** Needs the receiving pulse: the frame names neither its schema nor its layout. */
export function decodeCompactSet(bytes: Uint8Array, model: Model): Update {
	try {
		requireRun(bytes.length <= MAX_FRAME_BYTES, "Compact frame limit");
		const d = createDecoder(bytes);
		requireRun(
			uint(d) === COMPACT_VERSION && uint(d) === OPERATIONS_VERSION,
			"Unsupported compact version",
		);
		const flags = uint(d);
		requireRun(flags < 32, "Invalid compact flags");
		const docId = documentId(d);
		const requestId = flags & REQUEST ? uint(d) : 0,
			sid = uint(d),
			clock = uint(d),
			lamport = clock + uint(d),
			external = flags & EXTERNAL ? vector(d) : [];
		requireRun(
			(!(flags & REQUEST) || requestId > 0) &&
				sid >= 65536 &&
				clock >= 1 &&
				Number.isSafeInteger(lamport + 1) &&
				(!(flags & EXTERNAL) || external.length > 0) &&
				external.length + 1 <= MAX_VECTOR_ENTRIES,
			"Invalid compact range",
		);
		const derived = derivedVector(sid, clock, external),
			vv = flags & VECTOR ? vector(d) : derived;
		requireRun(
			!(flags & VECTOR) || !sameVector(vv, derived),
			"Noncanonical compact vector",
		);
		const actor = uint(d),
			created = uint(d),
			serial = uint(d);
		requireRun(actor <= external.length, "Invalid compact target");
		const target = `${actor ? external[actor - 1]![0] : sid}:${created}:${serial}`,
			field: CoreField = flags & NAMED ? text(d) : uint(d),
			column = model.scalarColumn(target, field);
		if (!column)
			throw new PulseError(
				model.index.has(target)
					? "INCOMPATIBLE_DOCUMENT"
					: "HISTORY_UNAVAILABLE",
				"Compact write requires its target in a single-version typed document",
			);
		// The run owns its value bytes; the caller keeps its frame.
		let source: Uint8Array;
		if (flags & INTEGER) {
			scratch.setFloat64(0, uint(d), true);
			source = scratchBytes.slice();
			requireRun(d.pos === bytes.length, "Trailing compact bytes");
		} else {
			source = bytes.slice(d.pos);
			requireRun(
				source.length > 0 &&
					(source.length !== 8 || integerAt(source, 0) === undefined),
				"Noncanonical compact value",
			);
		}
		const layout = column.id + 2,
			schema = model.schemaId,
			size = runOperationSize(
				{ schema, target, field, layout, lamport },
				0,
				source.length,
			);
		requireRun(size <= MAX_PATCH_BYTES, "Expanded compact payload limit");
		const spans = new Uint32Array(2);
		spans[1] = source.length;
		const run: ScalarRun = {
			docId,
			sid,
			clock,
			count: 1,
			lamport,
			schema,
			target,
			field,
			layout,
			external,
			source,
			spans,
			expandedBytes:
				bytes.length +
				size +
				(external.length + (clock > 1 ? 1 : 0)) * 16 +
				docId.length * 2 +
				40,
		};
		return { kind: 4, docId, requestId, vv, rows: runRows(run) };
	} catch (error) {
		if (error instanceof PulseError) throw error;
		throw new PulseError("INVALID_MESSAGE", "Cannot decode compact write", {
			cause: error,
		});
	}
}
