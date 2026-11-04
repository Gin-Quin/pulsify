import { encodePulseUpdates } from "../pulses/PulseExchange.js";
import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
import { asPulseError, PulseError, remoteError } from "../protocol/errors.js";
import { deferred } from "../utilities/deferred.js";
import type { ConnectionResponse } from "./ConnectionResponse.js";
import type { ConnectionStatus } from "./ConnectionStatus.js";
import type { Connector, ConnectorSession } from "./Connector.js";
import {
	decodeMessage,
	encodeMessage,
	type PulseMessage,
} from "./PulseMessage.js";
import {
	mergeVectors,
	vectorCovers,
	type PulseVersionVector,
} from "./PulseVersionVector.js";

type ConnectionEventMap = {
	connecting: [];
	connected: [];
	synced: [];
	closing: [];
	closed: [];
	error: [error: Error];
};
export type ConnectionEvent = keyof ConnectionEventMap;
export class Connection {
	status: ConnectionStatus = "idle";
	clockVector: PulseVersionVector = [];
	private session: ConnectorSession | undefined;
	private controller: AbortController | undefined;
	private readonly listeners = new Map<
		ConnectionEvent,
		Set<(...args: any[]) => void>
	>();
	private readonly pending = new Map<
		number,
		{ resolve(message: PulseMessage): void; reject(error: unknown): void }
	>();
	private nextRequestId = 1;
	private outbound: Promise<void> = Promise.resolve();
	private synced = deferred<void>();
	private stopRows: (() => void) | undefined;
	private scheduled = false;
	private epoch = 0;
	get whenSynced(): Promise<void> {
		return this.synced.promise;
	}
	constructor(
		public readonly pulse: Pulse<any>,
		public readonly connector: Connector,
	) {}

	prepare(): void {
		if (this.status === "closed" || this.status === "error") {
			this.status = "idle";
			this.synced = deferred<void>();
			this.outbound = Promise.resolve();
		}
	}
	async connect(): Promise<ConnectionResponse> {
		this.prepare();
		if (this.status !== "idle")
			throw new PulseError("CONNECTION_FAILED", "Connection is already active");
		const meta = getPulseMeta(this.pulse);
		if (meta.destroyed)
			throw new PulseError("CLOSED", "Pulse has been destroyed");
		const controller = new AbortController();
		this.controller = controller;
		const assertCurrent = () => {
			if (
				this.controller !== controller ||
				controller.signal.aborted ||
				meta.destroyed
			)
				throw new PulseError("CLOSED", "Connection replaced");
		};
		const opening = deferred<ConnectorSession>();
		const openTimer = setTimeout(
			() => opening.reject(new PulseError("TIMEOUT", "Transport did not open")),
			meta.options.timeoutMs,
		);
		const abort = () =>
			opening.reject(new PulseError("CLOSED", "Connection aborted"));
		controller.signal.addEventListener("abort", abort, { once: true });
		try {
			this.status = "connecting";
			this.clockVector = [];
			this.emit("connecting");
			assertCurrent();
			void this.connector
				.open({
					docId: meta.id,
					signal: controller.signal,
					onMessage: (bytes) => {
						if (this.controller === controller) this.receive(bytes);
					},
					onClose: (error) => {
						if (
							this.controller === controller &&
							this.status !== "closed" &&
							this.status !== "closing" &&
							this.status !== "error"
						)
							this.fail(error ?? new PulseError("CLOSED", "Transport closed"));
					},
				})
				.then((session) => {
					if (controller.signal.aborted) session.close();
					else opening.resolve(session);
				}, opening.reject);
			const session = await opening.promise;
			try {
				assertCurrent();
			} catch (error) {
				session.close();
				throw error;
			}
			this.session = session;
			controller.signal.removeEventListener("abort", abort);
			const onRows = () => this.scheduleSync();
			meta.rowListeners.add(onRows);
			this.stopRows = () => meta.rowListeners.delete(onRows);
			const response = await this.request({
				kind: 1,
				docId: meta.id,
				requestId: this.nextRequestId++,
				vv: meta.log.vector,
			});
			assertCurrent();
			if (response.kind !== 2)
				throw new PulseError("INVALID_MESSAGE", "Expected sync response");
			this.status = "connected";
			this.emit("connected");
			assertCurrent();
			return response;
		} catch (error) {
			if (this.controller === controller) this.fail(asPulseError(error));
			throw error;
		} finally {
			clearTimeout(openTimer);
			controller.signal.removeEventListener("abort", abort);
		}
	}

	syncBack(): Promise<void> {
		const epoch = this.epoch;
		const run = this.outbound.then(async () => {
			if (
				epoch !== this.epoch ||
				!this.session ||
				this.status === "closed" ||
				this.status === "error"
			)
				throw new PulseError("CLOSED", "Connection is closed");
			const meta = getPulseMeta(this.pulse);
			this.status = "syncing";
			const target = meta.log.vector;
			const requestId = this.nextRequestId++;
			const frames = encodePulseUpdates(meta, this.clockVector, {
				kind: 3,
				requestId,
				peerVersion: this.session.protocolVersion ?? 1,
			});
			this.nextRequestId += Math.max(0, frames.length - 1);
			for (let i = 0; i < frames.length; i++) {
				const response = await this.requestFrame(requestId + i, frames[i]!);
				if (epoch !== this.epoch)
					throw new PulseError("CLOSED", "Connection replaced");
				if (response.kind !== 5)
					throw new PulseError("INVALID_MESSAGE", "Expected acknowledgement");
			}
			if (!vectorCovers(this.clockVector, target))
				throw new PulseError(
					"CONNECTION_FAILED",
					"Peer did not acknowledge the complete history",
				);
			this.status = vectorCovers(this.clockVector, meta.log.vector)
				? "synced"
				: "syncing";
			this.synced.resolve();
			if (this.status === "synced") this.emit("synced");
			if (
				meta.connections.every(
					(connection) =>
						connection.status === "synced" &&
						vectorCovers(connection.clockVector, meta.log.vector),
				)
			)
				meta.status = "synced";
		});
		this.outbound = run;
		void run.catch((error) => {
			if (epoch === this.epoch) this.fail(asPulseError(error));
		});
		return run;
	}

	private scheduleSync(): void {
		if (
			this.scheduled ||
			!["connected", "synced", "syncing"].includes(this.status)
		)
			return;
		this.scheduled = true;
		const epoch = this.epoch;
		queueMicrotask(() => {
			if (epoch !== this.epoch) return;
			this.scheduled = false;
			if (["connected", "synced", "syncing"].includes(this.status))
				void this.syncBack().catch(() => {});
		});
	}
	private request(message: PulseMessage): Promise<PulseMessage> {
		return this.requestFrame(message.requestId, encodeMessage(message));
	}
	private requestFrame(
		requestId: number,
		frame: Uint8Array,
	): Promise<PulseMessage> {
		const result = deferred<PulseMessage>();
		const timer = setTimeout(
			() => result.reject(new PulseError("TIMEOUT", "Peer did not respond")),
			getPulseMeta(this.pulse).options.timeoutMs,
		);
		this.pending.set(requestId, result);
		try {
			if (!this.session) throw new PulseError("CLOSED", "Transport is closed");
			void this.session.send(frame).catch(result.reject);
		} catch (error) {
			result.reject(error);
		}
		return result.promise.finally(() => {
			clearTimeout(timer);
			this.pending.delete(requestId);
		});
	}
	private receive(bytes: Uint8Array): void {
		if (this.status === "closed" || this.status === "error") return;
		const epoch = this.epoch;
		try {
			if (bytes[0] === 2 && this.session?.protocolVersion !== 2)
				throw new PulseError(
					"UNSUPPORTED_VERSION",
					"Grouped transport was not negotiated",
				);
			const message = decodeMessage(bytes);
			const meta = getPulseMeta(this.pulse);
			if (message.docId !== meta.id)
				throw new PulseError("INVALID_MESSAGE", "Wrong document in response");
			if (message.kind === 6) throw remoteError(message.code, message.message);
			if (message.kind === 2) {
				const request = this.pending.get(message.requestId);
				if (!request)
					throw new PulseError("INVALID_MESSAGE", "Unknown sync request");
				this.clockVector = mergeVectors(this.clockVector, message.vv);
				meta.applyRows(message.rows);
				if (epoch !== this.epoch) return;
				if (message.complete) request.resolve(message);
			} else if (message.kind === 4 && message.requestId === 0) {
				this.clockVector = mergeVectors(this.clockVector, message.vv);
				meta.applyRows(message.rows);
			} else if (message.kind === 5 && this.pending.has(message.requestId)) {
				this.clockVector = mergeVectors(this.clockVector, message.vv);
				this.pending.get(message.requestId)!.resolve(message);
			} else
				throw new PulseError("INVALID_MESSAGE", "Unexpected peer response");
		} catch (error) {
			if (epoch === this.epoch) this.fail(asPulseError(error));
		}
	}

	close(): void {
		if (this.status === "closed") return;
		this.status = "closing";
		this.emit("closing");
		this.cleanup(new PulseError("CLOSED", "Connection closed"));
		this.status = "closed";
		this.emit("closed");
	}
	dispose(): void {
		this.close();
		this.listeners.clear();
	}
	private cleanup(error: Error): void {
		this.epoch++;
		this.scheduled = false;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		this.synced.reject(error);
		this.stopRows?.();
		this.stopRows = undefined;
		this.controller?.abort();
		this.controller = undefined;
		this.session?.close();
		this.session = undefined;
	}
	private fail(error: Error): void {
		if (
			this.status === "closed" ||
			this.status === "closing" ||
			this.status === "error"
		)
			return;
		this.status = "error";
		this.cleanup(error);
		const meta = getPulseMeta(this.pulse);
		meta.status = "error";
		meta.report(error);
		this.emit("error", error);
	}
	on<E extends ConnectionEvent>(
		event: E,
		listener: (...args: ConnectionEventMap[E]) => void,
	): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => this.off(event, listener);
	}
	once<E extends ConnectionEvent>(
		event: E,
		listener: (...args: ConnectionEventMap[E]) => void,
	): () => void {
		const stop = this.on(event, (...args) => {
			stop();
			listener(...args);
		});
		return stop;
	}
	off<E extends ConnectionEvent>(
		event: E,
		listener: (...args: ConnectionEventMap[E]) => void,
	): void {
		this.listeners.get(event)?.delete(listener);
	}
	private emit<E extends ConnectionEvent>(
		event: E,
		...args: ConnectionEventMap[E]
	): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			try {
				listener(...args);
			} catch (error) {
				getPulseMeta(this.pulse).report(asPulseError(error));
			}
		}
	}
}
