import { encodeHistoryRequest } from "../protocol/stateDeltas.js";
import { encodePulseUpdates } from "../pulses/PulseExchange.js";
import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
import {
	asPulseError,
	isRetryable,
	PulseError,
	remoteError,
} from "../protocol/errors.js";
import { deferred } from "../utilities/deferred.js";
import { isOnline, onOnline } from "../utilities/isOnline.js";
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
import { refreshPulseStatus } from "./refreshPulseStatus.js";
import type { ReconnectOptions } from "../pulses/PulseOptions.js";

type ConnectionEventMap = {
	connecting: [];
	connected: [];
	synced: [];
	/** A retryable failure; the next attempt starts after `delayMs`. */
	reconnecting: [error: Error, delayMs: number, attempt: number];
	closing: [];
	closed: [];
	/** Every failure, retryable or not. */
	error: [error: Error];
};
export type ConnectionEvent = keyof ConnectionEventMap;

/** Lazy waking waits at most this long, and so retries at most this often. */
const demandDelay = (options: ReconnectOptions) =>
	Math.min(options.maxDelayMs, 1_000);

const ESTABLISHED: readonly ConnectionStatus[] = [
	"connected",
	"syncing",
	"synced",
];

/**
 * One connector of one pulse. Once started, it keeps the pulse synchronized
 * with its connector: each attempt opens a session and performs a complete
 * synchronization, and a retryable failure schedules a new attempt with
 * backoff until `close()` or an error that a retry cannot fix.
 */
export class Connection {
	status: ConnectionStatus = "idle";
	clockVector: PulseVersionVector = [];
	/** The last failure, retryable or not. */
	lastError: Error | undefined;
	/** Consecutive failed attempts since the last successful connection. */
	attempt = 0;
	/** The connector has answered a complete download at least once. */
	downloaded = false;
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
	private syncWaiters = new Set<ReturnType<typeof deferred<void>>>();
	private stopRows: (() => void) | undefined;
	private scheduled = false;
	private epoch = 0;
	/** Incremented by `close()`; a lifecycle loop only runs for its generation. */
	private generation = 0;
	private running: number | undefined;
	private wanted = false;
	private outage = false;
	private ended: ReturnType<typeof deferred<void>> | undefined;
	/** The pending backoff wait, so `retryNow` and demand can shorten it. */
	private waiting:
		| {
				deadline: number;
				timer: ReturnType<typeof setTimeout>;
				resolve(): void;
		  }
		| undefined;
	/** A retry was requested before the backoff started waiting. */
	private retryRequested = false;
	/** Rows to upload arrived before the backoff started waiting. */
	private demanded = false;
	private stopOnline: (() => void) | undefined;

	/** Resolves after the next complete upload; rejects when stopped or closed. */
	get whenSynced(): Promise<void> {
		const waiter = deferred<void>();
		if (this.status === "synced") waiter.resolve();
		else if (this.status === "error" || this.status === "closed")
			waiter.reject(
				this.lastError ?? new PulseError("CLOSED", "Connection is closed"),
			);
		else this.syncWaiters.add(waiter);
		return waiter.promise;
	}
	get active(): boolean {
		return this.wanted;
	}
	private get reconnecting(): boolean {
		return this.status === "reconnecting";
	}
	constructor(
		public readonly pulse: Pulse<any>,
		public readonly connector: Connector,
	) {}

	/**
	 * Keep this connector synchronized until `close()`. Restarts a stopped
	 * connection and skips the backoff of a reconnecting one.
	 */
	start(): void {
		const meta = getPulseMeta(this.pulse);
		if (meta.destroyed) return;
		this.wanted = true;
		this.stopOnline ??= onOnline(() => this.networkChanged());
		if (!this.stopRows) {
			const onRows = () => {
				if (this.reconnecting) this.demand();
				else this.scheduleSync();
			};
			meta.rowListeners.add(onRows);
			this.stopRows = () => meta.rowListeners.delete(onRows);
		}
		if (this.status === "error" || this.status === "closed") {
			this.status = "idle";
			this.attempt = 0;
		}
		if (this.running === this.generation) {
			this.retryNow();
			return;
		}
		void this.run(this.generation);
	}

	/** Attempt now instead of waiting for the backoff delay. */
	retryNow(): void {
		if (this.waiting) {
			clearTimeout(this.waiting.timer);
			this.waiting.resolve();
		} else if (this.reconnecting) this.retryRequested = true;
	}

	private async run(generation: number): Promise<void> {
		this.running = generation;
		const meta = getPulseMeta(this.pulse);
		const current = () =>
			this.generation === generation && this.wanted && !meta.destroyed;
		try {
			while (current()) {
				try {
					await this.connect();
					const ended = this.ended;
					await this.synchronize();
					// The session lives until its transport fails or `close()`.
					await ended?.promise;
				} catch (error) {
					if (!current()) return;
					const failure = asPulseError(error);
					// Failures that did not go through `fail` (rejected uploads, races).
					if (!this.reconnecting) this.fail(failure);
					if (!this.reconnecting) return;
					await this.backoff(failure, current);
				}
			}
		} finally {
			if (this.running === generation) this.running = undefined;
		}
	}

	private async backoff(failure: Error, current: () => boolean) {
		const options = getPulseMeta(this.pulse).options.reconnect;
		if (!options) return;
		this.attempt++;
		const base = Math.min(
			options.maxDelayMs,
			options.initialDelayMs * options.factor ** (this.attempt - 1),
		);
		const delay = Math.round(base * (1 - options.jitter * Math.random()));
		this.emit("reconnecting", failure, delay, this.attempt);
		if (this.retryRequested) {
			this.retryRequested = false;
			if (isOnline()) return;
		}
		do {
			// Offline per the browser: wait for its `online` event, polling slowly.
			let wait = isOnline() ? delay : options.maxDelayMs;
			if (this.demanded && isOnline())
				wait = Math.min(wait, demandDelay(options));
			this.demanded = false;
			let waiting!: NonNullable<Connection["waiting"]>;
			await new Promise<void>((resolve) => {
				waiting = {
					deadline: Date.now() + wait,
					timer: setTimeout(resolve, wait),
					resolve,
				};
				this.waiting = waiting;
			});
			if (this.waiting === waiting) this.waiting = undefined;
		} while (current() && !isOnline());
	}

	/**
	 * Lazy waking: the pulse has rows to upload while this connector is down.
	 * Try again within a second instead of waiting for the full backoff, at
	 * most once a second while the connector stays down.
	 */
	private demand(): void {
		const waiting = this.waiting;
		const options = getPulseMeta(this.pulse).options.reconnect;
		if (!options || !isOnline()) return;
		if (!waiting) {
			this.demanded = true;
			return;
		}
		const cap = demandDelay(options);
		if (waiting.deadline - Date.now() <= cap) return;
		clearTimeout(waiting.timer);
		waiting.deadline = Date.now() + cap;
		waiting.timer = setTimeout(waiting.resolve, cap);
	}

	private networkChanged(): void {
		if (this.status === "reconnecting") this.retryNow();
		else if (ESTABLISHED.includes(this.status)) void this.probe();
	}

	/** One attempt: open a session and download what the connector has. */
	async connect(): Promise<ConnectionResponse> {
		const meta = getPulseMeta(this.pulse);
		if (meta.destroyed)
			throw new PulseError("CLOSED", "Pulse has been destroyed");
		if (ESTABLISHED.includes(this.status) || this.status === "connecting")
			throw new PulseError("CONNECTION_FAILED", "Connection is already active");
		const controller = new AbortController();
		this.controller = controller;
		this.ended = deferred<void>();
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
			// The connector's state is unknown: the session starts from scratch.
			this.clockVector = [];
			this.outbound = Promise.resolve();
			this.emit("connecting");
			assertCurrent();
			let opened: Promise<ConnectorSession>;
			try {
				opened = this.connector.open({
					docId: meta.id,
					signal: controller.signal,
					onMessage: (bytes) => {
						if (this.controller === controller) this.receive(bytes);
					},
					onClose: (error) => {
						if (
							this.controller === controller &&
							!["closed", "closing", "error", "reconnecting"].includes(
								this.status,
							)
						)
							this.fail(error ?? new PulseError("CLOSED", "Transport closed"));
					},
				});
			} catch (error) {
				opened = Promise.reject(error);
			}
			void opened.then((session) => {
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
			const response = await this.request({
				kind: 1,
				docId: meta.id,
				requestId: this.nextRequestId++,
				vv:
					(session.protocolVersion ?? 1) >= 3
						? meta.log.vector
						: meta.log.historyVector,
			});
			assertCurrent();
			if (response.kind !== 2)
				throw new PulseError("INVALID_MESSAGE", "Expected sync response");
			this.status = "connected";
			this.downloaded = true;
			this.attempt = 0;
			this.retryRequested = false;
			this.demanded = false;
			this.outage = false;
			refreshPulseStatus(meta);
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

	/** Upload until the connector acknowledged the complete local history. */
	private async synchronize(): Promise<void> {
		const meta = getPulseMeta(this.pulse);
		const epoch = this.epoch;
		do {
			if (epoch !== this.epoch)
				throw new PulseError("CLOSED", "Connection replaced");
			await this.syncBack();
		} while (!vectorCovers(this.clockVector, meta.log.vector));
	}

	/**
	 * Check that an established session still answers, and download anything
	 * it missed. A silent or closed transport reconnects. Runs when the network
	 * comes back; connectors detect dead transports themselves in between.
	 */
	async probe(): Promise<void> {
		if (!this.session || !ESTABLISHED.includes(this.status)) return;
		const meta = getPulseMeta(this.pulse);
		const epoch = this.epoch;
		try {
			await this.request({
				kind: 1,
				docId: meta.id,
				requestId: this.nextRequestId++,
				vv:
					(this.session.protocolVersion ?? 1) >= 3
						? meta.log.vector
						: meta.log.historyVector,
			});
		} catch (error) {
			if (epoch === this.epoch) this.fail(asPulseError(error));
		}
	}

	async fetchHistory(): Promise<void> {
		if (!this.session || !ESTABLISHED.includes(this.status))
			throw new PulseError("CLOSED", "No active history connection");
		const meta = getPulseMeta(this.pulse),
			message = {
				kind: 1 as const,
				docId: meta.id,
				requestId: this.nextRequestId++,
				vv: meta.log.historyVector,
			};
		const response = await this.requestFrame(
			message.requestId,
			this.session.protocolVersion === 3
				? encodeHistoryRequest(message, true)
				: encodeMessage(message),
		);
		if (response.kind !== 2)
			throw new PulseError("INVALID_MESSAGE", "Expected history sync response");
	}

	syncBack(): Promise<void> {
		const epoch = this.epoch;
		const run = this.outbound.then(async () => {
			if (
				epoch !== this.epoch ||
				!this.session ||
				!ESTABLISHED.includes(this.status)
			)
				throw new PulseError("CLOSED", "Connection is closed");
			const meta = getPulseMeta(this.pulse);
			this.status = "syncing";
			const target = meta.log.vector;
			const requestId = this.nextRequestId++;
			const frames = encodePulseUpdates(meta, this.clockVector, {
				kind: 3,
				requestId,
				peerVersion: (this.session.protocolVersion ?? 1) >= 2 ? 2 : 1,
				mode: "history",
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
			for (const waiter of this.syncWaiters) waiter.resolve();
			this.syncWaiters.clear();
			refreshPulseStatus(meta);
			if (this.status === "synced") this.emit("synced");
		});
		this.outbound = run;
		void run.catch((error) => {
			if (epoch === this.epoch) this.fail(asPulseError(error));
		});
		return run;
	}

	private scheduleSync(): void {
		if (this.scheduled || !ESTABLISHED.includes(this.status)) return;
		this.scheduled = true;
		const epoch = this.epoch;
		queueMicrotask(() => {
			if (epoch !== this.epoch) return;
			this.scheduled = false;
			if (ESTABLISHED.includes(this.status))
				void this.syncBack().catch(() => {});
		});
	}
	private request(message: PulseMessage): Promise<PulseMessage> {
		return this.requestFrame(
			message.requestId,
			message.kind === 1 && this.session?.protocolVersion === 3
				? encodeHistoryRequest(message, false)
				: encodeMessage(message),
		);
	}
	private requestFrame(
		requestId: number,
		frame: Uint8Array,
	): Promise<PulseMessage> {
		const result = deferred<PulseMessage>();
		const epoch = this.epoch;
		const timer = setTimeout(() => {
			const error = new PulseError("TIMEOUT", "Peer did not respond");
			result.reject(error);
			// A peer that stops answering is treated as a lost transport.
			if (epoch === this.epoch) this.fail(error);
		}, getPulseMeta(this.pulse).options.timeoutMs);
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
		if (!ESTABLISHED.includes(this.status) && this.status !== "connecting")
			return;
		const epoch = this.epoch;
		try {
			if (
				(bytes[0] === 2 && (this.session?.protocolVersion ?? 1) < 2) ||
				(bytes[0] === 3 && this.session?.protocolVersion !== 3)
			)
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
			// Applying received data failed (schema, migration, application code):
			// a new session would receive the same rows, so do not retry.
			if (epoch === this.epoch)
				this.fail(
					error instanceof PulseError
						? error
						: new PulseError("CONNECTION_FAILED", String(error), {
								cause: error,
								retryable: false,
							}),
				);
		}
	}

	/** Stop synchronizing this connector. `start()` resumes. */
	close(): void {
		this.wanted = false;
		this.generation++;
		this.retryNow();
		this.retryRequested = false;
		this.demanded = false;
		this.stopRows?.();
		this.stopRows = undefined;
		this.stopOnline?.();
		this.stopOnline = undefined;
		this.attempt = 0;
		this.outage = false;
		if (this.status === "closed") return;
		const error = new PulseError("CLOSED", "Connection closed");
		this.status = "closing";
		this.emit("closing");
		this.cleanup(error);
		this.rejectWaiters(error);
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
		this.ended?.reject(error);
		this.ended = undefined;
		this.controller?.abort();
		this.controller = undefined;
		this.session?.close();
		this.session = undefined;
	}
	private rejectWaiters(error: Error): void {
		for (const waiter of this.syncWaiters) waiter.reject(error);
		this.syncWaiters.clear();
	}
	private fail(error: Error): void {
		if (["closed", "closing", "error", "reconnecting"].includes(this.status))
			return;
		const failure = asPulseError(error);
		const meta = getPulseMeta(this.pulse);
		const retry =
			this.wanted &&
			!meta.destroyed &&
			meta.options.reconnect !== false &&
			isRetryable(failure);
		this.lastError = failure;
		this.status = retry ? "reconnecting" : "error";
		this.cleanup(failure);
		if (!retry) {
			this.wanted = false;
			this.stopRows?.();
			this.stopRows = undefined;
			this.rejectWaiters(failure);
		}
		// One report per outage: the retries that follow stay silent.
		if (!retry || !this.outage) meta.report(failure);
		this.outage = retry;
		refreshPulseStatus(meta);
		this.emit("error", failure);
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
