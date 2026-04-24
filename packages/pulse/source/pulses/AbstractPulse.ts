import { encodeUpdate, type Update } from "../types/Update";
import type { Connector } from "../types/Connector";
import { connectors as defaultConnectors } from "../types/Connector";
import mitt from "mitt";
import { bunker } from "@digitak/bunker";
import { StateVector } from "../types/StateVector";

export type PulseEvents<Content> = {
	update: Update<Content>;
};

export type PulseProperties = {
	id?: string;
	connectors?: Array<Connector>;
	synchronize?: boolean;
};

export abstract class AbstractPulse<Value, Content = Value> {
	readonly id: string;

	value: Value;

	state: unknown;
	stateVector = new StateVector();
	pendingUpdates: Array<Update<Content>> = [];

	connectors?: Array<Connector>;
	synchronized = false;

	private emitter = mitt<PulseEvents<Content>>();
	on = this.emitter.on.bind(this.emitter);
	off = this.emitter.off.bind(this.emitter);
	emit = this.emitter.emit.bind(this.emitter);

	constructor(
		value: Value,
		state: unknown,
		{
			id,
			synchronize = true,
			connectors = defaultConnectors,
		}: PulseProperties = {},
	) {
		this.value = value;
		this.state = state;
		this.id = id ?? "default";
		this.connectors = connectors;
		if (synchronize) this.synchronize();
	}

	/**
	 * Apply an update and send it to the connectors.
	 */
	sendUpdateToConnectors = (update: Update<Content>): void => {
		const encodedUpdate = encodeUpdate(update);
		this.connectors?.forEach((connector) => connector.send(encodedUpdate));
	};

	/**
	 * Merge updates into the state.
	 * This is where we handle conflicts, add pending udpates, etc.
	 */
	applyUpdate(update: Update<Content>): boolean {
		const currentActorClock = BigInt(this.stateVector.get(update.actor) ?? 0);
		let updateToApply = update;

		if (update.clock > currentActorClock) {
			// cannot assimilate, missing updates from the actor
			this.pendingUpdates.push(update);
			console.log("Update came before another update from the same actor");
			return false;
		} else if (update.clock < currentActorClock) {
			const clockOffset = Number(currentActorClock - update.clock);

			if (clockOffset > this.pendingUpdates.length) {
				console.log("Update already applied");
				return false;
			}

			console.log("Update already partially applied");

			// we only select the part of the update that has not yet been assimilated
			updateToApply = {
				actor: update.actor,
				clock: update.clock + BigInt(clockOffset),
				content: update.content.slice(clockOffset),
				key: update.key,
				left: update.left,
				right: update.right,
			};
		}

		this.stateVector.set(
			update.actor,
			update.clock + BigInt(update.content.length),
		);

		const assimilated = this.assimilateUpdate(updateToApply);

		if (assimilated) {
			this.applyPendingUpdates();
		} else {
			this.pendingUpdates.push(updateToApply);
		}

		return assimilated;
	}

	/**
	 * Apply pending updates.
	 * This could be much faster because this function needs to check every update of the state.
	 * We could use the trigger update here and directly checks if the trigger matches.
	 * Even better, we could use the index where the trigger update has been assimilated.
	 */
	applyPendingUpdates(): void {
		let index = 0;
		while (index < this.pendingUpdates.length) {
			const pendingUpdate = this.pendingUpdates[index];
			if (this.assimilateUpdate(pendingUpdate)) {
				this.pendingUpdates.splice(index, 1);
				index = 0;
			} else {
				index++;
			}
		}
	}

	/**
	 * Merge mutiple updates into the state.
	 */
	applyUpdates(updates: Array<Update<Content>>): void {
		for (const update of updates) {
			this.applyUpdate(update);
		}
	}

	/**
	 * Start synchronizing the Pulse with the default connectors.
	 */
	synchronize(): void {
		// TODO: add initial sync step
		this.on("update", this.sendUpdateToConnectors);
	}

	/**
	 * Stop synchronizing the Pulse with the connectors.
	 */
	desynchronize(): void {
		this.off("update", this.sendUpdateToConnectors);
	}

	/**
	 * Synchronizes the Pulse with the given connectors.
	 */
	connect(connectors: Array<Connector>): void {
		this.connectors ??= [];

		for (const connector of connectors) {
			if (!this.connectors.includes(connector)) {
				this.connectors.push(connector);
			}
		}
	}

	/**
	 * Desynchronizes the Pulse from the given connectors.
	 */
	disconnect(connectors: Array<Connector>): void {
		if (!this.connectors) return;
		for (const connector of connectors) {
			const index = this.connectors.indexOf(connector);
			if (index !== -1) this.connectors.splice(index, 1);
		}
	}
}
