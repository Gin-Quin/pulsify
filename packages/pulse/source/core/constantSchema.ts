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

export const VersionedSchemaSymbol: unique symbol = Symbol("VersionedSchema");
/** The marker holds whether each write also records its time. */
export type VersionedSchema<S extends Schema = Schema> =
	(S extends () => unknown ? S : () => S) & {
		readonly [VersionedSchemaSymbol]: boolean;
	};

/**
 * Keep every write of a value, and of the values inside it, in the document's
 * history. Without it a field keeps its last value only: a write replaces the
 * previous one in every store. `timestamps` also records when each write was
 * made, from the writer's clock.
 */
export function versioned<const S extends Schema>(
	schema: S,
	options: { timestamps?: boolean } = {},
): VersionedSchema<S> {
	// Codec lazy schemas return a concrete schema, so the markers of the
	// wrapped lazy schemas (a counter, a frozen value) move to this one.
	const marked = (() => {
		let inner: Schema = schema;
		while (typeof inner === "function") inner = inner();
		return inner;
	}) as Record<symbol, unknown> & (() => Schema);
	try {
		for (
			let inner: Schema = schema;
			typeof inner === "function";
			inner = inner()
		)
			for (const marker of Object.getOwnPropertySymbols(inner))
				marked[marker] = Reflect.get(inner, marker);
	} catch {
		/* A recursive schema that is not defined yet carries no marker. */
	}
	marked[VersionedSchemaSymbol] = options.timestamps === true;
	return Object.freeze(marked) as unknown as VersionedSchema<S>;
}

/** 0 without history, 1 with every write, 2 with every write and its time. */
export function historyOf(schema: Schema): 0 | 1 | 2 {
	const seen = new Set<Schema>();
	while (!seen.has(schema)) {
		seen.add(schema);
		if (typeof schema === "function") {
			const timestamps = Reflect.get(schema, VersionedSchemaSymbol);
			if (timestamps !== undefined) return timestamps ? 2 : 1;
			schema = schema();
		} else if (typeof schema === "object" && schema._type === "optional")
			schema = schema.schema;
		else return 0;
	}
	return 0;
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
