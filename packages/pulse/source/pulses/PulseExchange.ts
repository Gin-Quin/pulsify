import {
	createEncoder,
	writeFloat64,
	writeVarUint,
	writeVarString,
	toUint8Array,
} from "@gin-quin/codec";
import type { Pulse } from "./Pulse.js";
import { getPulseMeta, type PulseMeta } from "./PulseMeta.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import {
	encodeMessage,
	decodeMessage,
	type PulseMessage,
} from "../connection/PulseMessage.js";
import { MAX_LOG_BYTES, nativePatchOf } from "../protocol/PatchLog.js";
import {
	encodeOwnedRun,
	writeRunHeader,
	sameRunDependencies,
	runOperationSize,
	uintSize,
	utf8Length,
	type ScalarColumn,
} from "../protocol/scalarRuns.js";
import { chunkRows } from "../protocol/chunkRows.js";
import {
	MAX_FRAME_BYTES,
	MAX_MESSAGE_ROWS,
	MAX_SCHEMA_NODES,
	MAX_VECTOR_ENTRIES,
	MAX_PATCH_BYTES,
} from "../protocol/limits.js";
import { PulseError } from "../protocol/errors.js";
export const SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;
export type PulseExchangeOptions = {
	peerVersion?: 1 | 2;
	kind?: 3 | 4;
	requestId?: number;
};
/** Public normal export. Version 2 requires a known supporting peer. */
export function exportPulseUpdates(
	pulse: Pulse<any>,
	vv: PulseVersionVector,
	options: PulseExchangeOptions = {},
): Uint8Array[] {
	return encodePulseUpdates(getPulseMeta(pulse), vv, options);
}
export function applyPulseUpdates(
	pulse: Pulse<any>,
	frames: readonly Uint8Array[],
): void {
	const meta = getPulseMeta(pulse);
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	for (const bytes of frames) {
		const message = decodeMessage(bytes);
		if (message.docId !== meta.id || !("rows" in message))
			throw new PulseError("INVALID_MESSAGE", "Expected document update");
		meta.applyRows(message.rows);
	}
}
export function encodePulseUpdates(
	meta: PulseMeta,
	vv: PulseVersionVector,
	options: PulseExchangeOptions = {},
): Uint8Array[] {
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	if (options.kind !== undefined && options.kind !== 3 && options.kind !== 4)
		throw new TypeError("Invalid update kind");
	if (
		options.requestId !== undefined &&
		(!Number.isSafeInteger(options.requestId) || options.requestId < 0)
	)
		throw new TypeError("Invalid request ID");
	if (
		options.peerVersion !== undefined &&
		options.peerVersion !== 1 &&
		options.peerVersion !== 2
	)
		throw new TypeError("Invalid peer protocol version");
	const rows = meta.log.borrowMissing(vv),
		message = {
			kind: options.kind ?? 4,
			docId: meta.id,
			requestId: options.requestId ?? 0,
			vv: meta.log.vector,
			rows,
		} as Extract<PulseMessage, { kind: 3 | 4 }>;
	if (options.peerVersion === 2) {
		const grouped = encodeNativeRun(meta, message) ?? encodeOwnedRun(message);
		if (grouped) return [grouped];
	}
	return chunkRows(rows).map((chunk, i) =>
		encodeMessage(
			{ ...message, requestId: message.requestId + i, rows: chunk },
			{ peerVersion: options.peerVersion ?? 1 },
		),
	);
}
function encodeNativeRun(
	meta: PulseMeta,
	message: Extract<PulseMessage, { kind: 3 | 4 }>,
): Uint8Array<ArrayBuffer> | undefined {
	const rows = message.rows;
	if (rows.length < 2 || rows.length > MAX_MESSAGE_ROWS) return;
	const first = nativePatchOf(rows[0]!);
	if (!first) return;
	const column = meta.model.scalarColumn(first.target, first.field);
	if (!column || first.schema !== meta.model.schemaId) return;
	const run: ScalarColumn = {
		sid: first.sid,
		clock: first.clock,
		count: rows.length,
		lamport: first.lamport,
		schema: first.schema,
		target: first.target,
		field: first.field,
		layout: column.id + 2,
		external: rows[0]!.dependencies.filter(([sid]) => sid !== first.sid),
	};
	if (
		run.external.length + 1 > MAX_VECTOR_ENTRIES ||
		16 +
			message.vv.length * 3 +
			rows.length * (7 + 3 * (run.external.length + 1)) >
			MAX_SCHEMA_NODES
	)
		return;
	const e = createEncoder(Math.min(MAX_FRAME_BYTES, 256 + rows.length * 16));
	writeRunHeader(e, message, run);
	let expandedBytes = 0;
	const fixedOpBytes = runOperationSize(run, 0, 0) - uintSize(run.lamport) - 1;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!,
			patch = nativePatchOf(row);
		if (
			!patch ||
			row.span !== 1 ||
			patch.sid !== run.sid ||
			patch.clock !== run.clock + i ||
			patch.lamport !== run.lamport + i ||
			patch.schema !== run.schema ||
			patch.target !== run.target ||
			patch.field !== run.field ||
			!sameRunDependencies(row, run, i)
		)
			return;
		const textBytes =
			column.kind === "string" ? utf8Length(patch.value as string) : 0;
		const dataLength =
			column.kind === "float64" ? 8 : uintSize(textBytes) + textBytes;
		const opBytes =
			fixedOpBytes +
			uintSize(run.lamport + i) +
			uintSize(dataLength) +
			dataLength;
		if (opBytes > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		expandedBytes +=
			opBytes +
			(run.external.length + (run.clock + i > 1 ? 1 : 0)) * 16 +
			message.docId.length * 2 +
			40;
		if (expandedBytes + e.pos > MAX_LOG_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Expanded history limit exceeded");
		if (column.kind === "float64") {
			writeVarUint(e, 8);
			writeFloat64(e, patch.value as number);
		} else {
			writeVarUint(e, dataLength);
			writeVarString(e, patch.value as string);
		}
		if (e.pos > MAX_FRAME_BYTES) return;
	}
	if (expandedBytes + e.pos > MAX_LOG_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Expanded history limit exceeded");
	const bytes = toUint8Array(e);
	// Run decoder also checks expanded envelope/history bounds. The sender uses
	// the same structural limits without reading or materializing a document.
	return bytes;
}
