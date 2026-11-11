import type { Schema } from "@gin-quin/codec";
import type { AnyPulseDefinition } from "../pulses/PulseDefinition.js";

export const SubSchemaSymbol: unique symbol = Symbol("SubSchema");

/** Codec sees a lazy string schema holding the child ID; Pulsify also sees its definition. */
export type SubSchema<
	Definition extends AnyPulseDefinition = AnyPulseDefinition,
> = (() => "string") & { readonly [SubSchemaSymbol]: Definition };

/** Declare a field holding the ID of a child pulse whose ID starts with this pulse's ID. */
export function sub<const Definition extends AnyPulseDefinition>(
	definition: Definition,
): SubSchema<Definition> {
	if (!definition || typeof definition.kind !== "string")
		throw new TypeError("sub() requires a materialized pulse definition");
	return Object.freeze(
		Object.assign(() => "string" as const, { [SubSchemaSymbol]: definition }),
	);
}

/** Recognize a sub-pulse field through optional/lazy wrappers, at compile time only. */
export function subDefinitionOf(
	schema: Schema,
): AnyPulseDefinition | undefined {
	const seen = new Set<Schema>();
	while (!seen.has(schema)) {
		seen.add(schema);
		if (typeof schema === "function") {
			const definition = Reflect.get(schema, SubSchemaSymbol);
			if (definition) return definition as AnyPulseDefinition;
			schema = schema();
		} else if (typeof schema === "object" && schema._type === "optional")
			schema = schema.schema;
		else return undefined;
	}
	return undefined;
}
