import { PulseError } from "../protocol/errors.js";
import type { Pulsify } from "../utilities/pulsify.js";
import { type PulseMeta, PulseMetaSymbol } from "./PulseMeta.js";
import { defaultPulseScope } from "./PulseOptions.js";
import type { PulseProperties } from "./PulseProperties.js";

export const pulses = defaultPulseScope.pulses;
export type Pulse<
	Properties extends PulseProperties<string> = PulseProperties<string>,
> = { [Key in keyof Properties]: Pulsify<Properties[Key]> } & {
	readonly id: Properties["id"];
	readonly kind: Properties["kind"];
	readonly version: number;
	readonly [PulseMetaSymbol]: PulseMeta;
};

export function disconnectPulse(pulse: Pulse<any>): void {
	const meta = pulse[PulseMetaSymbol];
	meta.cancelConnection?.(new PulseError("CLOSED", "Pulse disconnected"));
	for (const connection of meta.connections) connection.close();
	meta.connecting = undefined;
	meta.status = "idle";
}
export function destroyPulse(pulse: Pulse<any>): void {
	const meta = pulse[PulseMetaSymbol];
	if (meta.destroyed) return;
	meta.destroyed = true;
	disconnectPulse(pulse);
	for (const connection of meta.connections) connection.dispose();
	meta.listeners.clear();
	meta.rowListeners.clear();
	meta.options.scope.pulses.delete(meta.id);
}
/** Subscribe synchronously to local and remote changes; first call is immediate. */
export function subscribePulse<P extends Pulse<any>>(
	pulse: P,
	listener: (pulse: P) => void,
): () => void {
	const meta = pulse[PulseMetaSymbol];
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	const wrapped = () => listener(pulse);
	meta.listeners.add(wrapped);
	try {
		wrapped();
	} catch (error) {
		meta.listeners.delete(wrapped);
		throw error;
	}
	return () => meta.listeners.delete(wrapped);
}
/** A detached snapshot of the public, materialized model. */
export type PulseSnapshot<Value> = Value extends readonly (infer Item)[]
	? PulseSnapshot<Item>[]
	: Value extends object
		? {
				[Key in keyof Value as Key extends string | number
					? Key
					: never]: PulseSnapshot<Value[Key]>;
			}
		: Value;
export function snapshotPulse<P extends Pulse<any>>(
	pulse: P,
): PulseSnapshot<P> {
	const meta = pulse[PulseMetaSymbol];
	if (!meta.definition.materializer)
		return structuredClone(
			meta.loaded ? meta.model.view() : {},
		) as PulseSnapshot<P>;
	const clone = (value: any): any =>
		value && typeof value === "object"
			? Array.isArray(value)
				? Array.from(value, clone)
				: Object.fromEntries(
						Object.entries(value).map(([key, item]) => [key, clone(item)]),
					)
			: value;
	return clone(pulse);
}
