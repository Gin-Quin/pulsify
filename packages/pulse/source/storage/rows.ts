import { stateDeltaOf } from "../protocol/stateDeltas.js";
import {
	rowDependencies,
	rowOperations,
	scalarEntryOf,
} from "../protocol/scalarRuns.js";
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
export type MissingPageOptions = {
	/** Resume after this cursor, as returned by the previous call. */
	after?: unknown;
	/** Soft byte budget for the page's rows. */
	maxBytes?: number;
	/** Maximum number of rows in the page. */
	maxRows?: number;
	/** Maximum schema node budget for the page's rows. */
	maxNodes?: number;
};
export type MissingPage = {
	rows: StoredPatchRow[];
	/** Document version vector from the same snapshot as `rows`. */
	vv: PulseVersionVector;
	/** Pass as `after` to read the next page; undefined on the last page. */
	next: unknown;
};
export interface PatchStore {
	append(rows: readonly StoredPatchRow[]): Promise<AppendResult>;
	appendEncoded(frame: Uint8Array): Promise<AppendResult>;
	vector(docId: string): Promise<PulseVersionVector>;
	missing(docId: string, remote: PulseVersionVector): Promise<StoredPatchRow[]>;
	/**
	 * Optional atomic, pageable read: returns missing rows and the document's
	 * version vector from one consistent snapshot.
	 */
	missingPage?(
		docId: string,
		remote: PulseVersionVector,
		options?: MissingPageOptions,
	): Promise<MissingPage>;
}

/** Durable document lifecycle, separate from opaque operation storage. */
export interface DocumentStore extends PatchStore {
	isDeleted(docId: string): Promise<boolean>;
	deleteDocuments(
		docId: string,
		options?: { preserveRows?: boolean },
	): Promise<number>;
	recoverRows(docId: string): Promise<StoredPatchRow[]>;
	documents(docId: string, after?: string, limit?: number): Promise<string[]>;
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
	const rows = message.rows;
	if (!rows.length || !scalarEntryOf(rows[0]!)) return rows;
	// Materialize RunRow getters once into plain rows for storage pipelines.
	return rows.map((row) => ({
		docId: row.docId,
		sid: row.sid,
		clock: row.clock,
		span: row.span,
		dependencies: rowDependencies(row),
		operations: rowOperations(row),
	}));
}

export function ownClock(
	dependencies: PulseVersionVector,
	sid: number,
): number {
	for (let i = 0; i < dependencies.length; i++) {
		const entry = dependencies[i]!;
		if (entry[0] === sid) return entry[1];
		if (entry[0] > sid) break;
	}
	return 0;
}

export function validateRows(
	rows: readonly StoredPatchRow[],
): string | undefined {
	if (rows.length > MAX_MESSAGE_ROWS)
		throw new PulseError("LIMIT_EXCEEDED", "Too many patch rows");
	const docId = rows[0]?.docId;
	if (docId !== undefined) validateDocId(docId);
	for (const row of rows) {
		const dependencies = rowDependencies(row);
		const operations = rowOperations(row);
		validateVector(dependencies);
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
			!(operations instanceof Uint8Array) ||
			!operations.length ||
			operations.length > MAX_PATCH_BYTES ||
			ownClock(dependencies, row.sid) > row.clock
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
	if (ownClock(next.dependencies, next.sid) < previous.clock + previous.span)
		throw new PulseError("CONFLICT", "Actor history fork");
}

/** The most bytes one packed segment holds: far below any row or message limit. */
export const MAX_PACKED_BYTES: number = 256 * 1024;

function pushVaruint(out: number[], value: number): void {
	// Clocks reach 2^53: no 32-bit operators.
	for (; value >= 128; value = Math.floor(value / 128))
		out.push((value % 128) | 128);
	out.push(value);
}

/**
 * One row of a packed segment: `span`, the dependencies in their order, then
 * the operation bytes, each number as a LEB128 varuint. The document, the
 * actor and the clock are those of the segment: its rows are contiguous.
 * Encoded rows are simply concatenated, so a segment grows by appending.
 */
export function encodePackedRow(
	row: Pick<StoredPatchRow, "span" | "dependencies" | "operations">,
): Uint8Array {
	const head: number[] = [];
	pushVaruint(head, row.span);
	pushVaruint(head, row.dependencies.length);
	for (const [sid, clock] of row.dependencies) {
		pushVaruint(head, sid);
		pushVaruint(head, clock);
	}
	pushVaruint(head, row.operations.length);
	const bytes = new Uint8Array(head.length + row.operations.length);
	bytes.set(head);
	bytes.set(row.operations, head.length);
	return bytes;
}

/** The rows of a packed segment that starts at `clock`, exactly as they were appended. */
export function decodePackedRows(
	docId: string,
	sid: number,
	clock: number,
	bytes: Uint8Array,
): StoredPatchRow[] {
	let offset = 0;
	const read = (): number => {
		let value = 0;
		for (let scale = 1; ; scale *= 128) {
			const byte = bytes[offset++];
			if (byte === undefined || !Number.isSafeInteger(value + byte * scale))
				throw new PulseError("INVALID_MESSAGE", "Corrupt packed segment");
			value += (byte & 127) * scale;
			if (byte < 128) return value;
		}
	};
	const rows: StoredPatchRow[] = [];
	while (offset < bytes.length) {
		const span = read();
		const dependencies: PulseVersionVector = [];
		for (let count = read(); count > 0; count--)
			dependencies.push([read(), read()]);
		const length = read();
		if (span < 1 || !length || offset + length > bytes.length)
			throw new PulseError("INVALID_MESSAGE", "Corrupt packed segment");
		rows.push({
			docId,
			sid,
			clock,
			span,
			dependencies,
			operations: bytes.slice(offset, offset + length),
		});
		offset += length;
		clock += span;
	}
	return rows;
}
