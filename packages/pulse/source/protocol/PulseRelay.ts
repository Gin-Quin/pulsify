import { decodeMessage, encodeMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { chunkRows } from "./chunkRows.js";
import { asPulseError, PulseError } from "./errors.js";
import { PatchLog } from "./PatchLog.js";

export type RelayPeer = { receive(bytes: Uint8Array): void; close(): void };
/** In-memory reference relay. Supply authentication/durable storage at the server boundary. */
export class PulseRelay {
	private readonly documents = new Map<string, PatchLog>();
	private readonly peers = new Set<{
		docId?: string;
		send(bytes: Uint8Array): void;
	}>();
	constructor(private readonly validateRow?: (row: PulsePatchRow) => void) {}
	get peerCount(): number {
		return this.peers.size;
	}
	getLog(docId: string): PatchLog | undefined {
		return this.documents.get(docId);
	}
	open(send: (bytes: Uint8Array) => void): RelayPeer {
		const peer: { docId?: string; send(bytes: Uint8Array): void } = { send };
		this.peers.add(peer);
		return {
			close: () => {
				this.peers.delete(peer);
			},
			receive: (bytes) => {
				if (!this.peers.has(peer))
					throw new PulseError("CLOSED", "Relay peer is closed");
				const message = decodeMessage(bytes);
				try {
					if (peer.docId !== undefined && peer.docId !== message.docId)
						throw new PulseError("INVALID_MESSAGE", "One document per session");
					if (message.kind === 1) {
						peer.docId = message.docId;
						const log = this.documents.get(message.docId);
						const chunks = chunkRows(log?.missing(message.vv) ?? []);
						if (!chunks.length) chunks.push([]);
						for (let i = 0; i < chunks.length; i++)
							send(
								encodeMessage({
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
					let log = this.documents.get(message.docId);
					if (!log) {
						log = new PatchLog(message.docId);
					}
					for (const row of message.rows) this.validateRow?.(row);
					const before = log.size;
					log.append(message.rows);
					this.documents.set(message.docId, log);
					send(
						encodeMessage({
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
							encodeMessage({
								kind: 4,
								docId: message.docId,
								requestId: 0,
								vv: log.vector,
								rows: message.rows,
							}),
						);
					}
				} catch (error) {
					const failure = asPulseError(error);
					send(
						encodeMessage({
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
