import { decodeMessage, encodeMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import type { MissingPage, PatchStore } from "../storage/rows.js";
import { chunkRows } from "./chunkRows.js";
import { asPulseError, PulseError } from "./errors.js";
import {
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
} from "./limits.js";
import {
	isPresenceFrame,
	relayPresenceFrame,
	type PresenceRelay,
} from "./presenceFrames.js";
import { stateDeltaOf } from "./stateDeltas.js";

export type StoreRelaySession = {
	protocolVersion?: 1 | 2 | 3;
	/** Readers may connect and download; uploads fail with `FORBIDDEN`. */
	readOnly?: boolean;
	/** Pin the session to one document; other document IDs are rejected. */
	docId?: string;
	/**
	 * Presence: a positive number that no other open session of the document
	 * uses. Without it, presence frames are rejected.
	 */
	peer?: number;
	/** Presence: the user you authenticated, shown to the other peers. */
	subject?: string;
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
	/**
	 * A presence frame to forward and never store: to the session whose peer
	 * number is `to`, or to every other session of the document that has sent
	 * a presence frame itself (older clients reject them).
	 */
	presence?: Omit<PresenceRelay, "docId">;
};
export type StoreRelayStreamResult = Omit<StoreRelayResult, "responses"> & {
	/**
	 * Frames for the requesting peer, produced incrementally one page at a
	 * time so the caller can send each frame before the next page is read.
	 */
	responses: AsyncIterable<Uint8Array<ArrayBuffer>>;
};

const PAGE_LIMITS = {
	maxBytes: 2 * MAX_PATCH_BYTES,
	maxRows: MAX_MESSAGE_ROWS,
	maxNodes: MAX_ROW_BATCH_NODES,
} as const;

async function* singleFrame(
	frame?: Uint8Array<ArrayBuffer>,
): AsyncGenerator<Uint8Array<ArrayBuffer>, void> {
	if (frame) yield frame;
}

/**
 * Serve one protocol frame from a durable store incrementally. On `connect`,
 * each page is read and encoded only as `responses` is iterated, so large
 * downloads never materialize all rows or frames in memory at once.
 */
export async function streamStoreMessage(
	store: PatchStore,
	bytes: Uint8Array,
	session: StoreRelaySession = {},
	validateRow?: (row: PulsePatchRow) => void,
): Promise<StoreRelayStreamResult> {
	if (isPresenceFrame(bytes)) {
		// Readers too: presence is not a write to the document.
		const { docId, ...presence } = relayPresenceFrame(bytes, {
			peer: session.peer ?? 0,
			...(session.subject ? { subject: session.subject } : {}),
		});
		if (session.docId !== undefined && session.docId !== docId)
			throw new PulseError("INVALID_MESSAGE", "One document per session");
		return { docId, responses: singleFrame(), presence };
	}
	const peerVersion = session.protocolVersion ?? 1;
	const encode = (message: Parameters<typeof encodeMessage>[0]) =>
		encodeMessage(message, { peerVersion });
	const message = decodeMessage(bytes);
	const { docId, requestId } = message;
	const encodeError = (error: unknown) => {
		const failure = asPulseError(error);
		return encode({
			kind: 6,
			docId,
			requestId,
			code: failure.code,
			message: failure.message,
		});
	};
	try {
		if (session.docId !== undefined && session.docId !== docId)
			throw new PulseError("INVALID_MESSAGE", "One document per session");
		if (session.readOnly && message.kind !== 1)
			throw new PulseError("FORBIDDEN", "This session cannot write");
		if (message.kind === 1) {
			const remoteVv = message.vv;
			if (store.missingPage) {
				const missingPage = store.missingPage.bind(store);
				let first: MissingPage | undefined = await missingPage(
					docId,
					remoteVv,
					PAGE_LIMITS,
				);
				async function* syncPages(): AsyncGenerator<
					Uint8Array<ArrayBuffer>,
					void
				> {
					let page: MissingPage = first!;
					first = undefined;
					let sentAny = false;
					try {
						for (;;) {
							const chunks = chunkRows(page.rows);
							if (!chunks.length && page.next === undefined && !sentAny)
								chunks.push([]);
							for (let i = 0; i < chunks.length; i++) {
								sentAny = true;
								yield encode({
									kind: 2,
									docId,
									requestId,
									found: page.vv.length > 0,
									complete: page.next === undefined && i === chunks.length - 1,
									vv: page.vv,
									rows: chunks[i]!,
								});
							}
							if (page.next === undefined) break;
							page = await missingPage(docId, remoteVv, {
								...PAGE_LIMITS,
								after: page.next,
							});
						}
					} catch (error) {
						yield encodeError(error);
					}
				}
				return { docId, responses: syncPages() };
			}
			const rows = await store.missing(docId, remoteVv);
			const vv = await store.vector(docId);
			const chunks = chunkRows(rows);
			if (!chunks.length) chunks.push([]);
			async function* syncChunks(): AsyncGenerator<
				Uint8Array<ArrayBuffer>,
				void
			> {
				for (let i = 0; i < chunks.length; i++)
					yield encode({
						kind: 2,
						docId,
						requestId,
						found: vv.length > 0,
						complete: i === chunks.length - 1,
						vv,
						rows: chunks[i]!,
					});
			}
			return { docId, responses: syncChunks() };
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
		const vv = result.vector ?? (await store.vector(docId));
		return {
			docId,
			responses: singleFrame(encode({ kind: 5, docId, requestId, vv })),
			...(result.inserted ? { broadcast: { rows: message.rows, vv } } : {}),
		};
	} catch (error) {
		return { docId, responses: singleFrame(encodeError(error)) };
	}
}

/**
 * Serve one protocol frame from a durable store, without an in-memory journal.
 * Rows are committed before the acknowledgement is produced. The caller owns
 * sockets: send `responses` to the peer and `encodeBroadcast` to the others.
 * Presence frames are not served from the store: forward `presence` as it
 * says, and send `encodePresenceLeave` to the others when a session ends.
 */
export async function relayStoreMessage(
	store: PatchStore,
	bytes: Uint8Array,
	session: StoreRelaySession = {},
	validateRow?: (row: PulsePatchRow) => void,
): Promise<StoreRelayResult> {
	const streamed = await streamStoreMessage(store, bytes, session, validateRow);
	const responses: Uint8Array<ArrayBuffer>[] = [];
	for await (const frame of streamed.responses) responses.push(frame);
	return { ...streamed, responses };
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
