import type { Model } from "json-joy/lib/json-crdt";
import type { Connection } from "pulse/connection/Connection";
import type { SynchronizationStatus } from "../connection/SynchronizationStatus";
import type { Pulse } from "./Pulse";
import type { AnyPulseDefinition } from "./PulseDefinition";

export const PulseMetaSymbol: unique symbol = Symbol("PulseMeta");

export type PulseMeta = {
	readonly id: string;
	readonly definition: AnyPulseDefinition;
	readonly model: Model;
	readonly pulse: Pulse<any>;
	status: SynchronizationStatus;
	connections: Array<Connection>;
};

/**
 * @returns The metadata associated to a pulse
 */
export function getPulseMeta(pulse: Pulse<any>): PulseMeta {
	return pulse[PulseMetaSymbol];
}
