import { encodeMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { chunkRows } from "./chunkRows.js";

/** Transport retained local operations through native IPC without JSON-encoding payloads. */
export function encodeRecoveryFrames(
	rows: readonly PulsePatchRow[],
): Uint8Array[] {
	const documents = new Map<string, PulsePatchRow[]>();
	for (const row of rows) {
		const list = documents.get(row.docId) ?? [];
		list.push(row);
		documents.set(row.docId, list);
	}
	return [...documents].flatMap(([docId, rows]) =>
		chunkRows(rows).map((rows) =>
			encodeMessage({ kind: 3, docId, requestId: 0, vv: [], rows }),
		),
	);
}
