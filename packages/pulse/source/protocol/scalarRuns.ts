import {
	createEncoder,
	createDecoder,
	readVarUint,
	readVarString,
	writeVarUint,
	writeVarString,
	writeVarUint8Array,
	toUint8Array,
	type Decoder,
	type Encoder,
} from "@gin-quin/codec";
import { OPERATIONS_VERSION } from "./versions.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseMessage } from "../connection/PulseMessage.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { validateDocId } from "./validateDocId.js";
import { PulseError } from "./errors.js";
import {
	MAX_FRAME_BYTES,
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_SCHEMA_NODES,
	MAX_VECTOR_ENTRIES,
} from "./limits.js";
import { MAX_LOG_BYTES } from "./PatchLog.js";

export interface ScalarRun {
	readonly docId: string;
	readonly sid: number;
	readonly clock: number;
	readonly count: number;
	readonly lamport: number;
	readonly schema: string;
	readonly target: string;
	readonly field: string | number;
	readonly layout: number;
	readonly external: PulseVersionVector;
	readonly source: Uint8Array;
	readonly spans: Uint32Array;
	readonly expandedBytes: number;
}
export interface ScalarColumn {
	sid: number;
	clock: number;
	lamport: number;
	schema: string;
	target: string;
	field: string | number;
	layout: number;
	external: PulseVersionVector;
	count: number;
}
const groups = new WeakMap<PulsePatchRow[], ScalarRun>();
export const scalarRunOf = (rows: PulsePatchRow[]) => groups.get(rows);
export const scalarEntryOf = (row: PulsePatchRow) => RunRow.entry(row);
export function requireRun(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) throw new PulseError("INVALID_MESSAGE", message);
}
export function uintSize(value: number): number {
	let n = 1;
	while (value >= 128) {
		n++;
		value = Math.floor(value / 128);
	}
	return n;
}
export function utf8Length(value: string): number {
	let n = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 128) n++;
		else if (c < 2048) n += 2;
		else if (
			c >= 0xd800 &&
			c <= 0xdbff &&
			i + 1 < value.length &&
			value.charCodeAt(i + 1) >= 0xdc00 &&
			value.charCodeAt(i + 1) <= 0xdfff
		) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}
const textSize = (s: string) => {
	const n = utf8Length(s);
	return uintSize(n) + n;
};
export function writeVector(e: Encoder, vv: PulseVersionVector): void {
	writeVarUint(e, vv.length);
	for (const [sid, clock] of vv) {
		writeVarUint(e, sid);
		writeVarUint(e, clock);
	}
}
export function runOperationSize(
	run: Pick<ScalarColumn, "schema" | "target" | "field" | "layout" | "lamport">,
	offset: number,
	payloadLength: number,
): number {
	return (
		1 +
		uintSize(run.lamport + offset) +
		textSize(run.schema) +
		2 +
		textSize(run.target) +
		1 +
		(typeof run.field === "string"
			? textSize(run.field)
			: uintSize(run.field)) +
		uintSize(run.layout) +
		uintSize(payloadLength) +
		payloadLength +
		2
	);
}
function uint(d: Decoder): number {
	const start = d.pos,
		n = readVarUint(d);
	requireRun(
		Number.isSafeInteger(n) && n >= 0 && uintSize(n) === d.pos - start,
		"Invalid run integer",
	);
	return n;
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function text(d: Decoder): string {
	const length = uint(d),
		end = d.pos + length;
	requireRun(end <= d.arr.length, "Truncated run string");
	const value = utf8.decode(d.arr.subarray(d.pos, end));
	d.pos = end;
	return value;
}
function vector(d: Decoder): PulseVersionVector {
	const n = uint(d);
	requireRun(n <= MAX_VECTOR_ENTRIES, "Run vector limit");
	const result: PulseVersionVector = [];
	for (let i = 0; i < n; i++) result.push([uint(d), uint(d)]);
	validateVector(result);
	return result;
}
export function runDependencies(
	run: Pick<ScalarRun, "sid" | "clock" | "external">,
	offset: number,
): PulseVersionVector {
	const result = run.external.map(([sid, clock]): [number, number] => [
			sid,
			clock,
		]),
		clock = run.clock + offset;
	if (clock > 1) {
		const at = result.findIndex(([sid]) => sid > run.sid);
		result.splice(at < 0 ? result.length : at, 0, [run.sid, clock]);
	}
	return result;
}
export function sameRunDependencies(
	row: PulsePatchRow,
	run: Pick<ScalarRun, "sid" | "clock" | "external">,
	offset: number,
): boolean {
	const vv = row.dependencies,
		clock = run.clock + offset;
	if (vv.length !== run.external.length + (clock > 1 ? 1 : 0)) return false;
	let i = 0;
	for (const [sid, time] of vv) {
		if (sid === run.sid) {
			if (clock === 1 || time !== clock) return false;
		} else {
			const expected = run.external[i++];
			if (!expected || expected[0] !== sid || expected[1] !== time)
				return false;
		}
	}
	return i === run.external.length;
}
export function writeRunHeader(
	e: Encoder,
	message: Extract<PulseMessage, { rows: PulsePatchRow[] }>,
	run: ScalarColumn,
): void {
	writeVarUint(e, 2);
	writeVarUint(e, OPERATIONS_VERSION);
	writeVarUint(e, message.kind);
	writeVarString(e, message.docId);
	writeVarUint(e, message.requestId);
	if (message.kind === 2) {
		writeVarUint(e, Number(message.found));
		writeVarUint(e, Number(message.complete));
	}
	writeVector(e, message.vv);
	writeVarUint(e, run.sid);
	writeVarUint(e, run.clock);
	writeVarUint(e, run.count);
	writeVarUint(e, run.lamport);
	writeVarString(e, run.schema);
	writeVarString(e, run.target);
	writeVarUint(e, typeof run.field === "string" ? 0 : 1);
	if (typeof run.field === "string") writeVarString(e, run.field);
	else writeVarUint(e, run.field);
	writeVarUint(e, run.layout);
	writeVector(e, run.external);
}
export function runOperation(
	run: ScalarRun,
	offset: number,
): Uint8Array<ArrayBuffer> {
	const e = createEncoder();
	writeVarUint(e, OPERATIONS_VERSION);
	writeVarUint(e, run.lamport + offset);
	writeVarString(e, run.schema);
	writeVarUint(e, 1);
	writeVarUint(e, 1);
	writeVarString(e, run.target);
	writeVarUint(e, typeof run.field === "string" ? 0 : 1);
	if (typeof run.field === "string") writeVarString(e, run.field);
	else writeVarUint(e, run.field);
	writeVarUint(e, run.layout);
	writeVarUint8Array(
		e,
		run.source.subarray(run.spans[offset * 2], run.spans[offset * 2 + 1]),
	);
	writeVarUint(e, 0);
	writeVarUint(e, 0);
	return toUint8Array(e);
}
class RunRow implements PulsePatchRow {
	#run: ScalarRun;
	#offset: number;
	#cached: Uint8Array | undefined;
	static entry(
		row: PulsePatchRow,
	): { run: ScalarRun; offset: number } | undefined {
		return row instanceof RunRow
			? { run: row.#run, offset: row.#offset }
			: undefined;
	}
	constructor(run: ScalarRun, offset: number) {
		this.#run = run;
		this.#offset = offset;
		Object.preventExtensions(this);
	}
	get docId() {
		return this.#run.docId;
	}
	get sid() {
		return this.#run.sid;
	}
	get clock() {
		return this.#run.clock + this.#offset;
	}
	get span() {
		return 1;
	}
	get dependencies() {
		return runDependencies(this.#run, this.#offset);
	}
	get operations() {
		return new Uint8Array(
			(this.#cached ??= runOperation(this.#run, this.#offset)),
		);
	}
}
Object.freeze(RunRow.prototype);

/** Owns the frame and validates expanded bounds before allocating individual rows. */
export function decodeRunMessage(bytes: Uint8Array): PulseMessage {
	try {
		requireRun(bytes.length <= MAX_FRAME_BYTES, "Run frame limit");
		const owned = new Uint8Array(bytes),
			d = createDecoder(owned);
		requireRun(
			uint(d) === 2 && uint(d) === OPERATIONS_VERSION,
			"Unsupported run version",
		);
		const kind = uint(d);
		requireRun(
			kind === 2 || kind === 3 || kind === 4,
			"Invalid run message kind",
		);
		const docId = text(d);
		validateDocId(docId);
		const requestId = uint(d);
		let found = false,
			complete = false;
		if (kind === 2) {
			const a = uint(d),
				b = uint(d);
			requireRun(a <= 1 && b <= 1, "Invalid boolean");
			found = !!a;
			complete = !!b;
		}
		const vv = vector(d),
			sid = uint(d),
			clock = uint(d),
			count = uint(d),
			lamport = uint(d);
		requireRun(
			sid >= 65536 &&
				clock >= 1 &&
				lamport >= 1 &&
				count >= 2 &&
				count <= MAX_MESSAGE_ROWS &&
				Number.isSafeInteger(clock + count) &&
				Number.isSafeInteger(lamport + count),
			"Invalid run range",
		);
		const schema = text(d),
			target = text(d),
			tag = uint(d);
		requireRun(tag <= 1, "Invalid run field");
		const field = tag === 0 ? text(d) : uint(d),
			layout = uint(d),
			external = vector(d);
		requireRun(
			!external.some(([actor]) => actor === sid) &&
				external.length + (clock + count > 2 ? 1 : 0) <= MAX_VECTOR_ENTRIES,
			"Invalid run dependencies",
		);
		requireRun(
			16 + vv.length * 3 + count * (7 + 3 * (external.length + 1)) <=
				MAX_SCHEMA_NODES,
			"Expanded run node limit",
		);
		const fixed =
			1 +
			textSize(schema) +
			2 +
			textSize(target) +
			1 +
			(typeof field === "string" ? textSize(field) : uintSize(field)) +
			uintSize(layout) +
			2;
		const start = d.pos;
		let expandedBytes = owned.length;
		for (let i = 0; i < count; i++) {
			const n = uint(d);
			requireRun(n <= d.arr.length - d.pos, "Truncated run value");
			d.pos += n;
			const opBytes = fixed + uintSize(lamport + i) + uintSize(n) + n;
			requireRun(opBytes <= MAX_PATCH_BYTES, "Expanded run payload limit");
			expandedBytes +=
				opBytes +
				(external.length + (clock + i > 1 ? 1 : 0)) * 16 +
				docId.length * 2 +
				40;
			requireRun(expandedBytes <= MAX_LOG_BYTES, "Expanded run byte limit");
		}
		requireRun(d.pos === owned.length, "Trailing run bytes");
		d.pos = start;
		const spans = new Uint32Array(count * 2);
		for (let i = 0; i < count; i++) {
			const n = uint(d);
			spans[i * 2] = d.pos;
			d.pos += n;
			spans[i * 2 + 1] = d.pos;
		}
		const run: ScalarRun = {
			docId,
			sid,
			clock,
			count,
			lamport,
			schema,
			target,
			field,
			layout,
			external,
			source: owned,
			spans,
			expandedBytes,
		};
		const rows: PulsePatchRow[] = Array.from(
			{ length: count },
			(_, i) => new RunRow(run, i),
		);
		Object.freeze(rows);
		groups.set(rows, run);
		return kind === 2
			? { kind, docId, requestId, vv, found, complete, rows }
			: { kind, docId, requestId, vv, rows };
	} catch (error) {
		if (error instanceof PulseError) throw error;
		throw new PulseError("INVALID_MESSAGE", "Cannot decode scalar run", {
			cause: error,
		});
	}
}
/** No interpretation/re-encoding of value bytes when forwarding an owned run. */
export function encodeOwnedRun(
	message: Extract<PulseMessage, { rows: PulsePatchRow[] }>,
): Uint8Array<ArrayBuffer> | undefined {
	if (message.rows.length < 2) return;
	requireRun(
		Number.isSafeInteger(message.requestId) && message.requestId >= 0,
		"Invalid run request ID",
	);
	const first = scalarEntryOf(message.rows[0]!);
	if (!first) return;
	const run = first.run,
		start = first.offset;
	if (start + message.rows.length > run.count) return;
	for (let i = 1; i < message.rows.length; i++) {
		const entry = scalarEntryOf(message.rows[i]!);
		if (entry?.run !== run || entry.offset !== start + i) return;
	}
	requireRun(message.rows[0]!.docId === message.docId, "Wrong run document");
	if (
		16 +
			message.vv.length * 3 +
			message.rows.length * (7 + 3 * (run.external.length + 1)) >
		MAX_SCHEMA_NODES
	)
		return;
	const e = createEncoder();
	writeRunHeader(e, message, {
		...run,
		clock: run.clock + start,
		lamport: run.lamport + start,
		count: message.rows.length,
	});
	for (let i = 0; i < message.rows.length; i++) {
		const offset = start + i;
		writeVarUint8Array(
			e,
			run.source.subarray(run.spans[offset * 2], run.spans[offset * 2 + 1]),
		);
	}
	const bytes = toUint8Array(e);
	if (
		bytes.length > MAX_FRAME_BYTES ||
		run.expandedBytes - run.source.length + bytes.length > MAX_LOG_BYTES
	)
		return;
	return bytes;
}

export function readRunValues(
	run: ScalarRun,
	kind: string,
): import("../core/operations.js").CoreScalar[] {
	const d = createDecoder(run.source),
		values: import("../core/operations.js").CoreScalar[] = [];
	for (let i = 0; i < run.count; i++) {
		const begin = run.spans[i * 2]!,
			end = run.spans[i * 2 + 1]!;
		d.pos = begin;
		let value: string | number;
		if (kind === "float64") {
			requireRun(end - begin === 8, "Invalid float64 run value");
			value = d.view.getFloat64(begin, true);
		} else {
			value = readVarString(d);
			requireRun(d.pos === end, "Trailing run value bytes");
		}
		values.push(value);
	}
	return values;
}
