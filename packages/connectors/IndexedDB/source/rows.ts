import {
	decodeMessage,
	isStateMessage,
	PulseError,
	validateVector,
	type PulseVersionVector,
} from "pulsify-core/protocol";
import { GAP_OPERATIONS, type StoredPatchRow } from "pulsify-core/storage";

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

/**
 * Mirror of the core SQLite store's reading: the rows an actor still holds,
 * sorted by clock, as a peer receives them. Each one's span runs to the next
 * one, the last one's to the frontier. A peer whose knowledge ends at `since`
 * gets the row that holds it and those after it, or a gap row up to the first
 * one when no row holds it.
 */
export function serve(
	docId: string,
	sid: number,
	held: StoredPatchRow[],
	since: number,
	frontier: number,
): StoredPatchRow[] {
	const from = Math.max(since, 1);
	let first = held.length;
	while (first > 0 && held[first - 1]!.clock > from) first--;
	const rows: StoredPatchRow[] = [];
	if (first === 0)
		rows.push({
			docId,
			sid,
			clock: from,
			span: (held[0]?.clock ?? frontier) - from,
			dependencies: from > 1 ? [[sid, from]] : [],
			operations: GAP_OPERATIONS.slice(),
		});
	for (let index = Math.max(first - 1, 0); index < held.length; index++) {
		const row = held[index]!;
		rows.push({
			...row,
			span: (held[index + 1]?.clock ?? frontier) - row.clock,
		});
	}
	return rows;
}
