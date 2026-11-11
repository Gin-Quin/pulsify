import { decodeMessage, encodeMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import type { PatchStore } from "../storage/rows.js";
import { chunkRows } from "./chunkRows.js";
import { asPulseError, PulseError } from "./errors.js";
import { stateDeltaOf } from "./stateDeltas.js";

export type StoreRelaySession = {
	protocolVersion?: 1 | 2 | 3;
	/** Readers may connect and download; uploads fail with `FORBIDDEN`. */
	readOnly?: boolean;
	/** Pin the session to one document; other document IDs are rejected. */
	docId?: string;
};
export type StoreRelayBroadcast = {
	rows: PulsePatchRow[];
	vv: PulseVersionVector;
};
export type StoreRelayResult = {
	docId: string;
	/** Frames for the requesting peer, in order. */
	responses: Uint8Array<ArrayBuffer>[];
	/** Newly stored rows to forward to the document's other peers. */
	broadcast?: StoreRelayBroadcast;
};

/**
 * Serve one protocol frame from a durable store, without an in-memory journal.
 * Rows are committed before the acknowledgement is produced. The caller owns
 * sockets: send `responses` to the peer and `encodeBroadcast` to the others.
 */
export async function relayStoreMessage(
	store: PatchStore,
	bytes: Uint8Array,
	session: StoreRelaySession = {},
	validateRow?: (row: PulsePatchRow) => void,
): Promise<StoreRelayResult> {
	const peerVersion = session.protocolVersion ?? 1;
	const encode = (message: Parameters<typeof encodeMessage>[0]) =>
		encodeMessage(message, { peerVersion });
	const message = decodeMessage(bytes);
	const { docId, requestId } = message;
	try {
		if (session.docId !== undefined && session.docId !== docId)
			throw new PulseError("INVALID_MESSAGE", "One document per session");
		if (session.readOnly && message.kind !== 1)
			throw new PulseError("FORBIDDEN", "This session cannot write");
		if (message.kind === 1) {
			const rows = await store.missing(docId, message.vv);
			const vv = await store.vector(docId);
			const chunks = chunkRows(rows);
			if (!chunks.length) chunks.push([]);
			return {
				docId,
				responses: chunks.map((chunk, i) =>
					encode({
						kind: 2,
						docId,
						requestId,
						found: vv.length > 0,
						complete: i === chunks.length - 1,
						vv,
						rows: chunk,
					}),
				),
			};
		}
		if (message.kind !== 3 && message.kind !== 4)
			throw new PulseError(
				"INVALID_MESSAGE",
				"Expected connect, syncBack or update",
			);
		if (stateDeltaOf(message.rows))
			throw new PulseError(
				"HISTORY_UNAVAILABLE",
				"Relay requires complete operation uploads",
			);
		for (const row of message.rows) validateRow?.(row);
		const result = await store.append(message.rows);
		const vv = await store.vector(docId);
		return {
			docId,
			responses: [encode({ kind: 5, docId, requestId, vv })],
			...(result.inserted ? { broadcast: { rows: message.rows, vv } } : {}),
		};
	} catch (error) {
		const failure = asPulseError(error);
		return {
			docId,
			responses: [
				encode({
					kind: 6,
					docId,
					requestId,
					code: failure.code,
					message: failure.message,
				}),
			],
		};
	}
}

export function encodeBroadcast(
	docId: string,
	broadcast: StoreRelayBroadcast,
	peerVersion: 1 | 2 | 3 = 1,
): Uint8Array<ArrayBuffer> {
	return encodeMessage(
		{ kind: 4, docId, requestId: 0, vv: broadcast.vv, rows: broadcast.rows },
		{ peerVersion },
	);
}
