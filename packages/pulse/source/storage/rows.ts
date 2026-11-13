import { stateDeltaOf } from "../protocol/stateDeltas.js";
import { wireCodec } from "../protocol/wireCodec.js";
import {
	PulsePatchRowSchema,
	decodeMessage,
} from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { MAX_MESSAGE_ROWS, MAX_PATCH_BYTES } from "../protocol/limits.js";
import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";

/** The storage layer only inspects this envelope, never the operation payload. */
export type StoredPatchRow = PulsePatchRow;
export type AppendResult = {
	inserted: number;
	ready: number;
	pending: number;
	/** The document's vector after the commit, when the store has it at hand. */
	vector?: PulseVersionVector;
};
export interface PatchStore {
	append(rows: readonly StoredPatchRow[]): Promise<AppendResult>;
	appendEncoded(frame: Uint8Array): Promise<AppendResult>;
	vector(docId: string): Promise<PulseVersionVector>;
	missing(docId: string, remote: PulseVersionVector): Promise<StoredPatchRow[]>;
}

const rowCodec = wireCodec(PulsePatchRowSchema);
export const encodeStoredRow = (row: StoredPatchRow): Uint8Array => {
	validateRows([row]);
	return rowCodec.encode(row);
};
export const decodeStoredRow = (bytes: Uint8Array): StoredPatchRow => {
	const row = rowCodec.decode(bytes);
	validateRows([row]);
	return row;
};

/** Accepts the normal protocol frame: one codec decode, then one database call. */
export function rowsFromFrame(bytes: Uint8Array): StoredPatchRow[] {
	const message = decodeMessage(bytes);
	if (!("rows" in message))
		throw new PulseError("INVALID_MESSAGE", "Storage requires a patch frame");
	if (stateDeltaOf(message.rows))
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"State deltas are not durable operation history",
		);
	return message.rows;
}

export function validateRows(
	rows: readonly StoredPatchRow[],
): string | undefined {
	if (rows.length > MAX_MESSAGE_ROWS)
		throw new PulseError("LIMIT_EXCEEDED", "Too many patch rows");
	const docId = rows[0]?.docId;
	if (docId !== undefined) validateDocId(docId);
	for (const row of rows) {
		validateVector(row.dependencies);
		if (
			!docId ||
			docId.length > 1024 ||
			row.docId !== docId ||
			!Number.isSafeInteger(row.sid) ||
			row.sid < 65536 ||
			!Number.isSafeInteger(row.clock) ||
			row.clock < 1 ||
			!Number.isSafeInteger(row.span) ||
			row.span < 1 ||
			!Number.isSafeInteger(row.clock + row.span) ||
			!(row.operations instanceof Uint8Array) ||
			!row.operations.length ||
			row.operations.length > MAX_PATCH_BYTES ||
			(new Map(row.dependencies).get(row.sid) ?? 0) > row.clock
		)
			throw new PulseError("INVALID_MESSAGE", "Invalid storage segment");
	}
	return docId;
}

export function covered(
	frontier: ReadonlyMap<number, number>,
	dependencies: PulseVersionVector,
): boolean {
	return dependencies.every(
		([sid, clock]) => (frontier.get(sid) ?? 0) >= clock,
	);
}

export function sameRow(a: StoredPatchRow, b: StoredPatchRow): boolean {
	const left = a.operations,
		right = b.operations;
	return (
		a.docId === b.docId &&
		a.sid === b.sid &&
		a.clock === b.clock &&
		a.span === b.span &&
		JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies) &&
		left.length === right.length &&
		left.every((v, i) => right[i] === v)
	);
}

export function assertCompatible(a: StoredPatchRow, b: StoredPatchRow): void {
	if (a.clock < b.clock + b.span && b.clock < a.clock + a.span)
		throw new PulseError("CONFLICT", "Overlapping immutable storage segments");
	const [previous, next] = a.clock < b.clock ? [a, b] : [b, a];
	if (
		(new Map(next.dependencies).get(next.sid) ?? 0) <
		previous.clock + previous.span
	)
		throw new PulseError("CONFLICT", "Actor history fork");
}
