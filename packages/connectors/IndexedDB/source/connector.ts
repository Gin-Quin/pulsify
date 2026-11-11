import { type Connector } from "pulsify-core";
import {
	encodeBroadcast,
	PulseError,
	relayStoreMessage,
} from "pulsify-core/protocol";
import { IndexedDbPatchStore, type IndexedDbOptions } from "./store.js";

export type IndexedDbConnector = Connector & {
	readonly kind: "local";
	readonly store: IndexedDbPatchStore;
	/** Deletes one document's local rows. Destroy its pulses first, or they write it back. */
	forget(docId: string): Promise<void>;
	/** Deletes every local document, e.g. on logout. */
	clear(): Promise<void>;
	/** Closes open sessions and the database; later `open()` calls fail. */
	close(): void;
};

type Session = {
	deliver(bytes: Uint8Array): void;
	fail(error: PulseError): void;
};
type ChannelMessage = { docId: string; frame: Uint8Array };

/**
 * Persists documents in IndexedDB and serves them as a local peer. Writes are
 * acknowledged after their transaction commits and are forwarded to the
 * document's other sessions, including other tabs through a BroadcastChannel.
 */
export function createIndexedDbConnector(
	options: IndexedDbOptions = {},
): IndexedDbConnector {
	const store = new IndexedDbPatchStore(options);
	const channelName = `pulsify-indexeddb:${store.name}`;
	const sessions = new Map<string, Set<Session>>();
	let channel: BroadcastChannel | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let closed = false;

	const listen = () => {
		if (channel || typeof BroadcastChannel === "undefined") return;
		channel = new BroadcastChannel(channelName);
		channel.onmessage = ({ data }: MessageEvent) => {
			const { docId, frame } = (data ?? {}) as Partial<ChannelMessage>;
			if (typeof docId !== "string" || !(frame instanceof Uint8Array)) return;
			for (const session of [...(sessions.get(docId) ?? [])])
				session.deliver(frame);
		};
	};
	const post = (message: ChannelMessage) => {
		if (typeof BroadcastChannel === "undefined") return;
		if (channel) return channel.postMessage(message);
		const once = new BroadcastChannel(channelName);
		once.postMessage(message);
		once.close();
	};
	const failAll = (error: PulseError) => {
		for (const peers of [...sessions.values()])
			for (const session of [...peers]) session.fail(error);
	};
	store.onConnectionLost(failAll);

	return {
		kind: "local",
		// One pool of reusable actor IDs per database: see "Actor IDs" in pulsify-core.
		actorPool: `indexeddb:${store.name}`,
		store,
		forget: (docId) => store.forget(docId),
		clear: () => store.clear(),
		close() {
			if (closed) return;
			closed = true;
			failAll(
				new PulseError("CLOSED", "IndexedDB connector closed", {
					retryable: false,
				}),
			);
			store.close();
			channel?.close();
			channel = undefined;
		},
		async open({ docId, signal, onMessage, onClose }) {
			const aborted = () => new PulseError("CLOSED", "Connection aborted");
			if (closed)
				throw new PulseError("CLOSED", "IndexedDB connector closed", {
					retryable: false,
				});
			if (signal.aborted) throw aborted();
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(aborted());
				signal.addEventListener("abort", abort, { once: true });
				store
					.database()
					.then(() => resolve(), reject)
					.finally(() => signal.removeEventListener("abort", abort));
			});
			if (closed)
				throw new PulseError("CLOSED", "IndexedDB connector closed", {
					retryable: false,
				});
			if (signal.aborted) throw aborted();

			let active = true;
			const close = () => {
				if (!active) return;
				active = false;
				signal.removeEventListener("abort", abort);
				const peers = sessions.get(docId);
				peers?.delete(session);
				if (peers?.size === 0) sessions.delete(docId);
				if (!sessions.size) {
					channel?.close();
					channel = undefined;
				}
			};
			const session: Session = {
				deliver(bytes) {
					if (active) onMessage(bytes);
				},
				fail(error) {
					if (!active) return;
					close();
					onClose(error);
				},
			};
			const abort = () => session.fail(aborted());
			signal.addEventListener("abort", abort, { once: true });
			let peers = sessions.get(docId);
			if (!peers) sessions.set(docId, (peers = new Set()));
			peers.add(session);
			listen();

			return {
				protocolVersion: 2,
				close,
				async send(bytes) {
					if (!active) throw new PulseError("CLOSED", "Connection closed");
					// One frame at a time, so acknowledgements and broadcasts keep order.
					const run = queue.then(() =>
						relayStoreMessage(store, bytes, { docId, protocolVersion: 2 }),
					);
					queue = run.catch(() => {});
					const result = await run;
					for (const frame of result.responses) session.deliver(frame);
					if (!result.broadcast) return;
					const frame = encodeBroadcast(docId, result.broadcast, 2);
					for (const peer of [...(sessions.get(docId) ?? [])])
						if (peer !== session) peer.deliver(frame);
					post({ docId, frame });
				},
			};
		},
	};
}
