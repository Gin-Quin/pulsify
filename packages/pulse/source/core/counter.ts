import { counterValue, type CoreModel, type CoreNode } from "./model.js";
import { CounterSchemaSymbol, CounterSymbol } from "./values.js";

/**
 * Codec sees a lazy float64 schema, which the scalar transports carry; Pulsify
 * also sees its collaborative marker, and accepts integers only.
 */
export type CounterSchema = (() => "float64") & {
	readonly [CounterSchemaSymbol]: true;
};

const counterSchema: CounterSchema = Object.freeze(
	Object.assign(() => "float64" as const, {
		[CounterSchemaSymbol]: true as const,
	}),
);

/**
 * A collaborative counter: every replica changes its own count and the value
 * is the sum of all counts, so concurrent changes all survive.
 */
export interface Counter {
	readonly [CounterSymbol]: true;
	readonly value: number;
	/** Add `amount`, a positive integer; 1 by default. */
	increment(amount?: number): void;
	/** Subtract `amount`, a positive integer; 1 by default. */
	decrement(amount?: number): void;
	/**
	 * Add the difference between `value` and the value this replica sees.
	 * Two replicas setting at the same time both add their difference.
	 */
	set(value: number): void;
	toJSON(): number;
	[Symbol.toPrimitive](): number;
}

/** Declare a collaborative counter field in a codec schema. */
export function counter(): CounterSchema;
/**
 * A value to assign where a counter is declared: `votes[key] = counter(0)`
 * creates it, and assigning to an existing counter is its `set`. Elsewhere it
 * is a number.
 */
export function counter(value: number): Counter;
export function counter(value?: number): CounterSchema | Counter {
	if (arguments.length === 0) return counterSchema;
	if (!Number.isSafeInteger(value))
		throw new TypeError("A counter value must be an integer");
	const unattached = () => {
		throw new TypeError("Attach a counter to a pulse before changing it");
	};
	return Object.freeze({
		[CounterSymbol]: true as const,
		value: value!,
		increment: unattached,
		decrement: unattached,
		set: unattached,
		toJSON: () => value!,
		[Symbol.toPrimitive]: () => value!,
	});
}

/** A stable view of the counter node, which holds one count per actor. */
export function createCounterProxy(
	node: CoreNode,
	model: CoreModel,
	assertActive: () => void,
): Counter {
	const value = () => {
		assertActive();
		if (!model.isAttached(node))
			throw new TypeError("This pulse counter has been replaced or removed");
		return counterValue(node);
	};
	const add = (amount: number, sign: number) => {
		value();
		if (!Number.isSafeInteger(amount) || amount < 1)
			throw new RangeError("A counter amount must be a positive integer");
		model.addCount(node, sign * amount);
	};
	return Object.freeze({
		[CounterSymbol]: true as const,
		get value() {
			return value();
		},
		increment: (amount = 1) => add(amount, 1),
		decrement: (amount = 1) => add(amount, -1),
		set(total: number) {
			const current = value();
			if (!Number.isSafeInteger(total))
				throw new RangeError("A counter value must be an integer");
			model.addCount(node, total - current);
		},
		toJSON: value,
		[Symbol.toPrimitive]: value,
	});
}
