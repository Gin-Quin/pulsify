import type { Model } from "json-joy/lib/json-crdt/index.js";
import type { PatchBuilder } from "json-joy/lib/json-crdt-patch/PatchBuilder.js";
import type { Connection } from "../connection/Connection.js";
import type { ConnectPulseResolvers } from "../connection/connectPulse.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { SynchronizationStatus } from "../connection/SynchronizationStatus.js";
import type { PatchLog } from "../protocol/PatchLog.js";
import type { Pulse } from "./Pulse.js";
import type { AnyPulseDefinition } from "./PulseDefinition.js";
import type { PulseOptions } from "./PulseOptions.js";

export const PulseMetaSymbol: unique symbol = Symbol("PulseMeta");
export type PulseMeta = {
	readonly id: string;
	readonly definition: AnyPulseDefinition;
	readonly model: Model;
	readonly log: PatchLog;
	readonly options: PulseOptions;
	pulse: Pulse<any>;
	status: SynchronizationStatus;
	destroyed: boolean;
	loaded: boolean;
	lastError: Error | undefined;
	connections: Connection[];
	connecting: ConnectPulseResolvers<Pulse<any>> | undefined;
	cancelConnection: ((error: Error) => void) | undefined;
	listeners: Set<() => void>;
	rowListeners: Set<() => void>;
	mutate<T>(callback: (builder: PatchBuilder) => T): T;
	applyRows(rows: PulsePatchRow[]): void;
	report(error: Error): void;
};
export function getPulseMeta(pulse: Pulse<any>): PulseMeta {
	return pulse[PulseMetaSymbol];
}
