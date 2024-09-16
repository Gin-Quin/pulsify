import { type Update } from "../types/Update"
import { type Connector } from "../types/Connector"
import { connectors } from "../values/connectors"
import { encodeUpdate } from "../functions/encodeUpdate"

export abstract class BasePulse<T> {
	readonly id: string
	value: T

	connectors?: Array<Connector>

	abstract state: unknown

	constructor(value: T, properties: { id?: string; synchronize?: boolean } = {}) {
		this.value = value
		this.id = properties.id ?? "default"
	}

	/**
	 * Default connectors to synchronize with when a new Pulse is synchronized.
	 */
	static connectors = Array<Connector>()

	/**
	 * Encode the state of the Pulse into a byte array.
	 */
	abstract encode(): Uint8Array

	/**
	 * Apply an update and send it to the connectors.
	 */
	update(update: Update): void {
		this.applyUpdates([update])
		const encodedUpdate = encodeUpdate(update)
		this.getConnectors().forEach(connector => connector.send(encodedUpdate))
	}

	/**
	 * Applies the given updates to the Pulse.
	 */
	abstract applyUpdates(updates: Update[]): void

	/**
	 *
	 */
	getConnectors(): Array<Connector> {
		return this.connectors ?? connectors ?? []
	}

	/**
	 * Synchronizes the Pulse with the default connectors.
	 */
	synchronize(): void {}

	/**
	 * Desynchronizes the Pulse from all connectors.
	 */
	desynchronize(): void {}

	/**
	 * Synchronizes the Pulse with the given connectors.
	 */
	synchronizeWith(connectors: Array<Connector>): void {}

	/**
	 * Desynchronizes the Pulse from the given connectors.
	 */
	desynchronizeWith(connectors: Array<Connector>): void {}
}
