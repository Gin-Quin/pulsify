import type { PulsePatchRow } from "../connection/PulsePatch.js";
import {
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
} from "./limits.js";
import { PulseError } from "./errors.js";

export { MAX_PATCH_BYTES } from "./limits.js";
/** Leave room in each frame for document identifiers, vectors and headers. */
export function chunkRows(rows: PulsePatchRow[]): PulsePatchRow[][] {
	const chunks: PulsePatchRow[][] = [];
	let chunk: PulsePatchRow[] = [];
	let bytes = 0;
	let nodes = 0;
	for (const row of rows) {
		if (row.operations.length > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		const size =
			row.operations.length +
			row.dependencies.length * 16 +
			row.docId.length * 4 +
			64;
		const rowNodes = 7 + 3 * row.dependencies.length;
		if (
			chunk.length &&
			(bytes + size > 2 * MAX_PATCH_BYTES ||
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
