import type { DeepReadonly } from "./DeepReadonly.js";
export const StructSymbol: unique symbol = Symbol("Struct");

export type Struct<Values extends Record<string, unknown>> = {
	readonly [Key in keyof Values]: DeepReadonly<Values[Key]>;
} & {
	readonly [StructSymbol]: true;
};

export function struct<Values extends Record<string, unknown>>(
	struct: Values,
): Struct<Values> {
	const clone = structuredClone(struct);
	Object.defineProperty(clone, StructSymbol, {
		value: true,
		enumerable: false,
		configurable: false,
	});
	return clone as Struct<Values>;
}

export function isStruct<Value extends Record<string, unknown>>(
	value: unknown,
): value is Struct<Value> {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as { [StructSymbol]?: true })[StructSymbol] === true,
	);
}
