import type { PulsePatchRow } from "../connection/PulsePatch.js";
import {
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
} from "./limits.js";
import { PulseError } from "./errors.js";
import { rowDependencies, rowOperations } from "./scalarRuns.js";

export { MAX_PATCH_BYTES } from "./limits.js";
/**
 * Leave room in each frame for document identifiers, vectors and headers.
 * A chunk goes past `maxBytes` only to hold one row, of 1 MiB at most.
 */
export function chunkRows(
	rows: PulsePatchRow[],
	maxBytes: number = 2 * MAX_PATCH_BYTES,
): PulsePatchRow[][] {
	const chunks: PulsePatchRow[][] = [];
	let chunk: PulsePatchRow[] = [];
	let bytes = 0;
	let nodes = 0;
	for (const row of rows) {
		const length = rowOperations(row).length;
		const dependencies = rowDependencies(row).length;
		if (length > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		const size = length + dependencies * 16 + row.docId.length * 4 + 64;
		const rowNodes = 7 + 3 * dependencies;
		if (
			chunk.length &&
			(bytes + size > maxBytes ||
				chunk.length >= MAX_MESSAGE_ROWS ||
				nodes + rowNodes > MAX_ROW_BATCH_NODES)
		) {
			chunks.push(chunk);
			chunk = [];
			bytes = 0;
			nodes = 0;
		}
		chunk.push(row);
		bytes += size;
		nodes += rowNodes;
	}
	if (chunk.length) chunks.push(chunk);
	return chunks;
}
