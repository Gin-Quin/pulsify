import { encodeStateUpdates } from "./stateExchange.js";
import { historyRequestOf, stateDeltaOf } from "./stateDeltas.js";
import { decodeMessage, encodeMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { chunkRows } from "./chunkRows.js";
import { asPulseError, PulseError } from "./errors.js";
import { PatchLog } from "./PatchLog.js";
import {
	createPresenceBudget,
	encodePresenceLeave,
	isPresenceFrame,
	relayPresenceFrame,
} from "./presenceFrames.js";

export type RelayPeer = { receive(bytes: Uint8Array): void; close(): void };
/** In-memory reference relay. Supply authentication/durable storage at the server boundary. */
export class PulseRelay {
	readonly protocolVersion = 3 as const;
	private readonly documents = new Map<string, PatchLog>();
	private readonly peers = new Set<{
		docId: string | undefined;
		send(bytes: Uint8Array): void;
		protocolVersion: 1 | 2 | 3;
		/** The session's presence peer number, unique in this relay. */
		number: number;
		/** The session sent a presence frame, so it understands them. */
		presence: boolean;
	}>();
	private lastPeer = 0;
	constructor(private readonly validateRow?: (row: PulsePatchRow) => void) {}
	get peerCount(): number {
		return this.peers.size;
	}
	getLog(docId: string): PatchLog | undefined {
		return this.documents.get(docId);
	}
	open(
		send: (bytes: Uint8Array) => void,
		options: {
			protocolVersion?: 1 | 2 | 3;
			/** Readers may connect and download; uploads fail with `FORBIDDEN`. */
			readOnly?: boolean;
			/** Pin the session to one document before its connect message. */
			docId?: string;
			/** The user you authenticated: the other peers read it next to this session's presence. */
			subject?: string;
		} = {},
	): RelayPeer {
		const peer = {
			docId: options.docId,
			send,
			protocolVersion: options.protocolVersion ?? 1,
			number: ++this.lastPeer,
			presence: false,
		};
		const budget = createPresenceBudget();
		// Nothing repeats a presence frame: one socket that fails while it
		// closes must not keep the frame from the others.
		const deliver = (
			other: { send(bytes: Uint8Array): void },
			bytes: Uint8Array,
		) => {
			try {
				other.send(bytes);
			} catch {
				// That session's own close announces its departure.
			}
		};
		/** The document's other sessions that use presence. */
		const presenceOthers = () =>
			[...this.peers].filter(
				(other) =>
					other !== peer && other.presence && other.docId === peer.docId,
			);
		this.peers.add(peer);
		const encode = (message: Parameters<typeof encodeMessage>[0]) =>
			encodeMessage(message, { peerVersion: peer.protocolVersion });
		return {
			close: () => {
				if (!this.peers.delete(peer)) return;
				// Presence is never stored: a session that ends just leaves.
				if (!peer.presence || peer.docId === undefined) return;
				const leave = encodePresenceLeave(peer.docId, peer.number);
				for (const other of presenceOthers()) deliver(other, leave);
			},
			receive: (bytes) => {
				if (!this.peers.has(peer))
					throw new PulseError("CLOSED", "Relay peer is closed");
				if (isPresenceFrame(bytes)) {
					// Readers too: presence is not a write to the document.
					const presence = relayPresenceFrame(bytes, {
						peer: peer.number,
						...(options.subject ? { subject: options.subject } : {}),
					});
					if (peer.docId === undefined || peer.docId !== presence.docId)
						throw new PulseError(
							"INVALID_MESSAGE",
							"Connect to the document before sending presence",
						);
					peer.presence = true;
					// A session over its budget is not an error: frames are dropped.
					if (!budget()) return;
					for (const other of presenceOthers())
						if (!presence.to || presence.to === other.number)
							deliver(other, presence.frame);
					return;
				}
				if (
					(bytes[0] === 2 && peer.protocolVersion < 2) ||
					(bytes[0] === 3 && peer.protocolVersion !== 3)
				)
					throw new PulseError(
						"UNSUPPORTED_VERSION",
						"Grouped transport was not negotiated",
					);
				const message = decodeMessage(bytes);
				try {
					if (peer.docId !== undefined && peer.docId !== message.docId)
						throw new PulseError("INVALID_MESSAGE", "One document per session");
					if (options.readOnly && message.kind !== 1)
						throw new PulseError("FORBIDDEN", "This session cannot write");
					if (message.kind === 1) {
						peer.docId = message.docId;
						const log = this.documents.get(message.docId);
						if (
							peer.protocolVersion === 3 &&
							log &&
							historyRequestOf(message) === false
						) {
							for (const frame of encodeStateUpdates(log, message.vv, {
								kind: 2,
								docId: message.docId,
								requestId: message.requestId,
								found: !!log.size,
								complete: true,
								vv: log.vector,
								rows: [],
							}))
								send(frame);
							return;
						}
						const chunks = chunkRows(log?.borrowMissing(message.vv) ?? []);
						if (!chunks.length) chunks.push([]);
						for (let i = 0; i < chunks.length; i++)
							send(
								encode({
									kind: 2,
									docId: message.docId,
									requestId: message.requestId,
									found: !!log?.size,
									complete: i === chunks.length - 1,
									vv: log?.vector ?? [],
									rows: chunks[i]!,
								}),
							);
						return;
					}
					if (
						(message.kind !== 3 && message.kind !== 4) ||
						peer.docId === undefined
					)
						throw new PulseError(
							"INVALID_MESSAGE",
							"Expected connect, syncBack or update",
						);
					if (stateDeltaOf(message.rows))
						throw new PulseError(
							"HISTORY_UNAVAILABLE",
							"Relay requires complete operation uploads",
						);
					let log = this.documents.get(message.docId);
					if (!log) {
						log = new PatchLog(message.docId);
					}
					for (const row of message.rows) this.validateRow?.(row);
					const before = log.size;
					log.append(message.rows);
					this.documents.set(message.docId, log);
					send(
						encode({
							kind: 5,
							docId: message.docId,
							requestId: message.requestId,
							vv: log.vector,
						}),
					);
					if (log.size === before) return;
					for (const other of this.peers) {
						if (other === peer || other.docId !== message.docId) continue;
						other.send(
							encodeMessage(
								{
									kind: 4,
									docId: message.docId,
									requestId: 0,
									vv: log.vector,
									rows: message.rows,
								},
								{ peerVersion: other.protocolVersion },
							),
						);
					}
				} catch (error) {
					const failure = asPulseError(error);
					send(
						encode({
							kind: 6,
							docId: message.docId,
							requestId: message.requestId,
							code: failure.code,
							message: failure.message,
						}),
					);
				}
			},
		};
	}
}
