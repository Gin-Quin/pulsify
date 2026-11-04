import type { DeepReadonly } from "./DeepReadonly.js";
export const TupleSymbol: unique symbol = Symbol("Tuple");

export type Tuple<Values extends readonly unknown[]> = DeepReadonly<Values> & {
	readonly [TupleSymbol]: true;
};

export function tuple<Values extends readonly unknown[]>(
	tuple: [...Values],
): Tuple<Values> {
	const clone = structuredClone(tuple);
	Object.defineProperty(clone, TupleSymbol, {
		value: true,
		enumerable: false,
		configurable: false,
	});
	return clone as unknown as Tuple<Values>;
}

export function isTuple(value: unknown): value is Tuple<readonly unknown[]> {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as { [TupleSymbol]?: true })[TupleSymbol] === true,
	);
}
