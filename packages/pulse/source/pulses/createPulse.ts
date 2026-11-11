import { connectPulse } from "../connection/connectPulse.js";
import type { RichText } from "../core/richText.js";
import type { Tree } from "../core/tree.js";
import type { TreeData } from "../core/treeSchema.js";
import { PulseError } from "../protocol/errors.js";
import { getPulseMeta } from "./PulseMeta.js";
import type { Pulse } from "./Pulse.js";
import type { SubPulse } from "./SubPulse.js";
import type {
	AnyPulseDefinition,
	DataFromDefinition,
	ModelFromDefinition,
} from "./PulseDefinition.js";
import { defaultPulseOptions, type PulseOptions } from "./PulseOptions.js";
import type { PulseProperties } from "./PulseProperties.js";
import { createRuntime } from "./PulseRuntime.js";

export type InitialValue<Value> = unknown extends Value
	? Value
	: Value extends SubPulse<infer Definition>
		? string | SubPulse<Definition> | Pulse<ModelFromDefinition<Definition>>
		: Value extends RichText
			? string | RichText
			: Value extends Tree<infer Item>
				? TreeData<InitialValue<Item>> | Tree<Item>
				: Value extends Uint8Array
					? Uint8Array
					: Value extends (...args: never[]) => unknown
						? Value
						: Value extends object
							? { [Key in keyof Value]: InitialValue<Value[Key]> }
							: Value;

export type CreatePulseInput<Properties extends PulseProperties<string>> =
	Properties extends unknown
		? {
				[
					Key in keyof Omit<
						Properties,
						"id" | "kind" | "version" | "generation"
					>
				]: InitialValue<Properties[Key]>;
			} & Partial<Pick<Properties, "id">>
		: never;
export type CreatePulseOptions = Partial<PulseOptions> & {
	/**
	 * Create a sub-pulse: the ID is prefixed by the parent ID and the parent
	 * scope, connectors and other options are inherited unless overridden.
	 */
	parent?: Pulse<any>;
};
export function createPulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	input: CreatePulseInput<DataFromDefinition<Definition>>,
	pulseOptions: CreatePulseOptions = {},
): Pulse<ModelFromDefinition<Definition>> {
	const { parent, ...overrides } = pulseOptions;
	const options = {
		...defaultPulseOptions,
		...(parent ? getPulseMeta(parent).options : {}),
		...overrides,
	};
	let id = input.id;
	if (parent) {
		const prefix = `${parent.id}/`;
		if (id === undefined) id = prefix + options.createId();
		else if (!id.startsWith(prefix))
			throw new TypeError(`A sub-pulse ID must start with ${prefix}`);
	}
	id ??= options.createId();
	const existing = options.scope.pulses.get(id);
	if (existing) {
		if (getPulseMeta(existing).definition !== definition)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"ID already belongs to a different pulse definition",
			);
		return existing as Pulse<ModelFromDefinition<Definition>>;
	}
	for (const key of ["kind", "version", "generation"])
		if (Object.hasOwn(input, key))
			throw new TypeError(`${key} is managed by Pulsify`);
	const pulse = createRuntime(definition, id, options, {
		...input,
		id,
		kind: definition.kind,
		version: definition.migrations.length + 1,
		generation: 0,
	});
	if (options.connect) connectPulse(pulse);
	return pulse as Pulse<ModelFromDefinition<Definition>>;
}
