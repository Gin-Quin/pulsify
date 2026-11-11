import {
	decodeMessage,
	isStateMessage,
	PulseError,
	validateVector,
	type PulseVersionVector,
} from "pulsify-core/protocol";
import { type StoredPatchRow } from "pulsify-core/storage";

// Mirrors of the core storage limits and checks, which are not public exports.
export const MAX_MESSAGE_ROWS = 4096;
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_VECTOR_ENTRIES = 1024;

export function validateDocId(docId: string): void {
	if (
		typeof docId !== "string" ||
		!docId.length ||
		docId.length > 1024 ||
		!docId.isWellFormed() ||
		docId.includes("\0")
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid document ID");
}

export function rowsFromFrame(bytes: Uint8Array): StoredPatchRow[] {
	const message = decodeMessage(bytes);
	if (!("rows" in message))
		throw new PulseError("INVALID_MESSAGE", "Storage requires a patch frame");
	if (isStateMessage(message))
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
