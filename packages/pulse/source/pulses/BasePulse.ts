import { type Update } from "../types/Update"
import { type Connector } from "../types/Connector"
import { connectors as defaultConnectors } from "../values/connectors"
import { encodeUpdate } from "../functions/encodeUpdate"
import mitt from "mitt"
import { bunker } from "@digitak/bunker"
import { assimilateUpdate, AssimilateUpdateError } from "../functions/assimilateUpdate"
import type { State } from "../types/State"

type PulseEvents = {
	update: Update
}

export abstract class BasePulse<T> {
	readonly id: string
	value: T

	connectors?: Array<Connector>
	synchronized = false

	private emitter = mitt<PulseEvents>()
	on = this.emitter.on.bind(this.emitter)
	off = this.emitter.off.bind(this.emitter)
	emit = this.emitter.emit.bind(this.emitter)

	state: State = []
	pendingUpdates: Array<Update> = []

	constructor(
		value: T,
		{
			id,
			synchronize = true,
			connectors = defaultConnectors,
		}: { id?: string; connectors?: Array<Connector>; synchronize?: boolean } = {}
	) {
		this.value = value
		this.id = id ?? "default"
		this.connectors = connectors
		if (synchronize) this.synchronize()
	}

	/**
	 * Encode the state of the Pulse into a byte array.
	 */
	encode(): Uint8Array {
		return bunker(this.state)
	}

	/**
	 * Apply an update and send it to the connectors.
	 */
	sendUpdateToConnectors = (update: Update): void => {
		const encodedUpdate = encodeUpdate(update)
		this.connectors?.forEach(connector => connector.send(encodedUpdate))
	}

	/**
	 * Merge updates into the state.
	 * This is where we handle conflicts, add pending udpates, etc.
	 */
	applyUpdate(update: Update): number {
		const assimilated = assimilateUpdate(this.state, update)

		if (assimilated == AssimilateUpdateError.CantAssimilate) {
			this.pendingUpdates.push(update)
		} else if (assimilated >= 0) {
			this.applyPendingUpdates(update, assimilated)
		}

		return assimilated
	}

	/**
	 * Apply pending updates.
	 * This could be much faster because this function needs to check every update of the state.
	 * We could use the trigger update here and directly checks if the trigger matches.
	 * Even better, we could use the index where the trigger update has been assimilated.
	 */
	applyPendingUpdates(triggerUpdate: Update, triggerIndex: number): void {
		let index = 0
		while (index < this.pendingUpdates.length) {
			const pendingUpdate = this.pendingUpdates[index]
			if (assimilateUpdate(this.state, pendingUpdate)) {
				this.pendingUpdates.splice(index, 1)
				index = 0
			} else {
				index++
			}
		}
	}

	/**
	 * Merge mutiple updates into the state.
	 */
	applyUpdates(updates: Array<Update>): void {
		for (const update of updates) {
			this.applyUpdate(update)
		}
	}

	/**
	 * Start synchronizing the Pulse with the default connectors.
	 */
	synchronize(): void {
		// TODO: add initial sync step
		this.on("update", this.sendUpdateToConnectors)
	}

	/**
	 * Stop synchronizing the Pulse with the connectors.
	 */
	desynchronize(): void {
		this.off("update", this.sendUpdateToConnectors)
	}

	/**
	 * Synchronizes the Pulse with the given connectors.
	 */
	connect(connectors: Array<Connector>): void {
		this.connectors ??= []

		for (const connector of connectors) {
			if (!this.connectors.includes(connector)) {
				this.connectors.push(connector)
			}
		}
	}

	/**
	 * Desynchronizes the Pulse from the given connectors.
	 */
	disconnect(connectors: Array<Connector>): void {
		if (!this.connectors) return
		for (const connector of connectors) {
			const index = this.connectors.indexOf(connector)
			if (index !== -1) this.connectors.splice(index, 1)
		}
	}
}
