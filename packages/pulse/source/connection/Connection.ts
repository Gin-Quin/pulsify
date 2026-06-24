import type { ClockVector } from "json-joy";
import type { Pulse } from "pulse/pulses/Pulse";
import { getPulseMeta } from "pulse/pulses/PulseMeta";
import { isEmptyDelta } from "pulse/utilities/isEmptyDelta";
import type { ConnectionResponse } from "./ConnectionResponse";
import type { ConnectionStatus } from "./ConnectionStatus";
import type { Connector } from "./Connector";

export type ConnectionEvent =
	| "connecting"
	| "connected"
	| "synced"
	| "closing"
	| "closed";
export type ConnectionListener = () => any;

export type ConnectionEventMap = Record<ConnectionEvent, Array<unknown>>;

export type ConnectionEventListener<Events extends ConnectionEventMap> = (
	...payload: Events[ConnectionEvent]
) => void;

export class Connection {
	status: ConnectionStatus = "idle";
	clockVector: ClockVector | null = null;

	private readonly listeners = new Map<
		ConnectionEvent,
		Set<ConnectionListener>
	>();

	constructor(
		public readonly pulse: Pulse,
		public readonly connector: Connector,
	) {}

	close: () => unknown = () => {};

	async connect(): Promise<ConnectionResponse> {
		if (this.status !== "idle") {
			console.log(
				`No need to connect: current connection status is ${this.status}.`,
			);
			return null;
		}
		this.status = "connecting";
		this.emit("connecting");

		const meta = getPulseMeta(this.pulse);

		const { close, done } = this.connector.connect({
			clockVector: meta.model.clock,
		});
		this.close = close;

		const response = await done;

		switch (this.status as ConnectionStatus) {
			case "closing":
			case "closed":
				// connection has been closed before first sync finished
				return null;
		}

		if (response) {
			const { delta } = response;
			meta.model.applyDelta(delta);

			// we store the connector's clock vector for future sync
			this.clockVector = delta.vv1;
		}

		this.status = "connected";
		this.emit("connected");

		return response;
	}

	/**
	 * Sends data back to the connector if needed to make sure the document
	 * is up-to-date.
	 */
	async sync() {
		const meta = getPulseMeta(this.pulse);
		const delta = meta.model.delta(meta.model.clock);
		if (!isEmptyDelta(delta)) {
			await this.connector.sync({ delta });
		}
		this.status = "synced";
		this.emit("synced");
	}

	/**
	 * Register a new event listener.
	 */
	on(event: ConnectionEvent, listener: ConnectionListener): () => void {
		let eventListeners = this.listeners.get(event);
		if (!eventListeners) {
			eventListeners = new Set();
			this.listeners.set(event, eventListeners);
		}
		eventListeners.add(listener);
		return () => this.off(event, listener);
	}

	/**
	 * Register a new event listener that will self-destruct once done.
	 */
	once(event: ConnectionEvent, listener: ConnectionListener): void {
		let eventListeners = this.listeners.get(event);
		if (!eventListeners) {
			eventListeners = new Set();
			this.listeners.set(event, eventListeners);
		}
		const remover = () => {
			eventListeners.delete(listener);
			eventListeners.delete(remover);
		};
		eventListeners.add(listener);
		eventListeners.add(remover);
	}

	/**
	 * Un-register a new event listener.
	 */
	off(event: ConnectionEvent, listener: ConnectionListener): void {
		this.listeners.get(event)?.delete(listener);
	}

	/**
	 * Emit a new event.
	 */
	emit(event: ConnectionEvent): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener();
		}
	}
}
