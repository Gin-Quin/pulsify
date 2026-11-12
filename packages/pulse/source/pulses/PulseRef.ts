import { PulseRefSymbol } from "../core/values.js";
import type { Pulse } from "./Pulse.js";
import type {
	AnyPulseDefinition,
	ModelFromDefinition,
} from "./PulseDefinition.js";
import { getPulseMeta } from "./PulseMeta.js";
import type { PulseOptions } from "./PulseOptions.js";
import { loadPulse, type LoadPulseOptions } from "./loadPulse.js";

/**
 * A reference to a child pulse stored by ID. The wire value is the ID string;
 * `pulse` is the loaded instance when it exists in the parent's scope, and
 * `load` inherits the parent's scope and connectors unless overridden.
 */
export type PulseRef<
	Definition extends AnyPulseDefinition = AnyPulseDefinition,
> = {
	readonly [PulseRefSymbol]: true;
	readonly id: string;
	readonly definition: Definition;
	readonly pulse: Pulse<ModelFromDefinition<Definition>> | undefined;
	load(
		options?: LoadPulseOptions,
	): Promise<Pulse<ModelFromDefinition<Definition>>>;
};

export function createPulseRef(
	definition: AnyPulseDefinition,
	id: string,
	parentOptions: PulseOptions,
): PulseRef {
	return {
		[PulseRefSymbol]: true,
		id,
		definition,
		get pulse() {
			return parentOptions.scope.pulses.get(id);
		},
		load: (options = {}) =>
			loadPulse(definition, id, { ...parentOptions, ...options }),
	};
}

export function isPulseRef(value: unknown): value is PulseRef {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [PulseRefSymbol]?: unknown })[PulseRefSymbol] === true
	);
}

/** A reference to an existing pulse, assignable to any `sub()` field. */
export function pulseRef(pulse: Pulse<any>): PulseRef<any> {
	const meta = getPulseMeta(pulse);
	return createPulseRef(meta.definition, meta.id, meta.options);
}
