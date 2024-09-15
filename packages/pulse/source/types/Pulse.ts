import { me } from "../values/me"
import { Peer } from "./Peer"
import { PulseUpdate } from "./Update"

export function pulse<T>(
	value: T,
	properties: { id?: string; synchronize?: boolean } = {}
): Pulse<T> {
	return new Pulse(value, properties)
}

export class Pulse<T> {
	value: T
	readonly id: string

	constructor(value: T, properties: { id?: string; synchronize?: boolean } = {}) {
		this.value = value
		this.id = properties.id ?? "default"
	}

	/**
	 * Default peers to synchronize with when a new Pulse is synchronized.
	 */
	static peers = new Array<Peer>()

	encode(): Uint8Array {}

	/**
	 * Sets the value of the Pulse.
	 */
	set(value: T, client = me()): void {
		this.value = value
		this.applyUpdates([{ type: "object", key: "value", value }])
	}

	/**
	 * Applies the given updates to the Pulse.
	 */
	applyUpdates(updates: PulseUpdate[]): void {}

	/**
	 * Synchronizes the Pulse with the default peers.
	 */
	synchronize(): void {}

	/**
	 * Desynchronizes the Pulse from all peers.
	 */
	desynchronize(): void {}

	/**
	 * Synchronizes the Pulse with the given peers.
	 */
	synchronizeWith(peers: Array<Peer>): void {}

	/**
	 * Desynchronizes the Pulse from the given peers.
	 */
	desynchronizeWith(peers: Array<Peer>): void {}
}
