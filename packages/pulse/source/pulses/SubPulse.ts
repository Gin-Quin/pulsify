import { SubPulseSymbol } from "../core/values.js";
import type { Pulse } from "./Pulse.js";
import type {
	AnyPulseDefinition,
	ModelFromDefinition,
} from "./PulseDefinition.js";
import { getPulseMeta } from "./PulseMeta.js";
import type { PulseOptions } from "./PulseOptions.js";
import { loadPulse, type LoadPulseOptions } from "./loadPulse.js";

/**
 * A handle to a child pulse stored by ID. The wire value is the ID string;
 * `pulse` is the loaded instance when it exists in the parent's scope, and
 * `load` inherits the parent's scope and connectors unless overridden.
 */
export type SubPulse<
	Definition extends AnyPulseDefinition = AnyPulseDefinition,
> = {
	readonly [SubPulseSymbol]: true;
	readonly id: string;
	readonly definition: Definition;
	readonly pulse: Pulse<ModelFromDefinition<Definition>> | undefined;
	load(
		options?: LoadPulseOptions,
	): Promise<Pulse<ModelFromDefinition<Definition>>>;
};

export function createSubPulse(
	definition: AnyPulseDefinition,
	id: string,
	parentOptions: PulseOptions,
): SubPulse {
	return {
		[SubPulseSymbol]: true,
		id,
		definition,
		get pulse() {
			return parentOptions.scope.pulses.get(id);
		},
		load: (options = {}) =>
			loadPulse(definition, id, { ...parentOptions, ...options }),
	};
}

export function isSubPulse(value: unknown): value is SubPulse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [SubPulseSymbol]?: unknown })[SubPulseSymbol] === true
	);
}

/** A handle for an existing pulse, assignable to any `sub()` field. */
export function subPulse(pulse: Pulse<any>): SubPulse<any> {
	const meta = getPulseMeta(pulse);
	return createSubPulse(meta.definition, meta.id, meta.options);
}
