import type { Schema } from "@gin-quin/codec";

export const ConstantSchemaSymbol: unique symbol = Symbol("ConstantSchema");
export const FrozenSchemaSymbol: unique symbol = Symbol("FrozenSchema");

/** Codec sees a lazy schema with unchanged bytes; Pulsify also sees its marker. */
/** Markers wrap concrete schemas: codec lazy schemas cannot return lazy schemas. */
type ConcreteSchema = Exclude<Schema, () => unknown>;
export type ConstantSchema<S extends ConcreteSchema = ConcreteSchema> =
	(() => S) & {
		readonly [ConstantSchemaSymbol]: true;
	};
export type FrozenSchema<S extends ConcreteSchema = ConcreteSchema> =
	(() => S) & {
		readonly [FrozenSchemaSymbol]: true;
	};

/** Declare a value that keeps its initial value: it can be neither replaced nor edited. */
export function constant<const S extends ConcreteSchema>(
	schema: S,
): ConstantSchema<S> {
	return Object.freeze(
		Object.assign(() => schema, { [ConstantSchemaSymbol]: true as const }),
	);
}

/** Declare a value that can be replaced as a whole, but whose contents cannot be edited. */
export function frozen<const S extends ConcreteSchema>(
	schema: S,
): FrozenSchema<S> {
	return Object.freeze(
		Object.assign(() => schema, { [FrozenSchemaSymbol]: true as const }),
	);
}

/** Recognize a marker through optional/lazy wrappers, at compile time only. */
export function hasSchemaMarker(schema: Schema, marker: symbol): boolean {
	const seen = new Set<Schema>();
	while (!seen.has(schema)) {
		seen.add(schema);
		if (typeof schema === "function") {
			if (Reflect.get(schema, marker) === true) return true;
			schema = schema();
		} else if (typeof schema === "object" && schema._type === "optional")
			schema = schema.schema;
		else return false;
	}
	return false;
}
