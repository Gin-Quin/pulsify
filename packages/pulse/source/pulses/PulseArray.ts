import type { ArrApi } from "json-joy/lib/json-crdt";
import { toNodeBuilder } from "pulse/utilities/toNodeBuilder";
import type { JsonValue } from "../utilities/JsonValue";

const IsApplyingNativeMutation = Symbol("IsApplyingNativeMutation");
const ApiSymbol = Symbol("ApiSymbol");

export class PulseArray<Item> extends Array<Item> implements PulseArray<Item> {
	private [ApiSymbol]: ArrApi;
	[IsApplyingNativeMutation] = false;

	static override get [Symbol.species](): ArrayConstructor {
		return Array;
	}

	override get length(): number {
		return super.length;
	}

	override set length(value: number) {
		const length = normalizeLength(value);

		if (length < this.length) {
			this[ApiSymbol].del(length, this.length - length);
			super.length = length;
		} else if (length > this.length) {
			console.error(
				RangeError(
					"PulseArray cannot be extended by setting length because sparse values cannot be represented.",
				),
			);
		}
	}

	constructor(api: ArrApi, array: Array<Item>) {
		super();
		super.push(...array);
		this[ApiSymbol] = api;

		// Required to intercept numeric index assignments such as pulseArray[0] = value.
		// biome-ignore lint/correctness/noConstructorReturn: Derived constructors may return an object.
		return new Proxy(this, {
			set(target, property, value, receiver) {
				if (
					!target[IsApplyingNativeMutation] &&
					typeof property === "string" &&
					isArrayIndex(property)
				) {
					const index = Number(property);

					if (index > target.length) {
						throw new RangeError(
							"PulseArray cannot assign past the end because sparse values cannot be represented.",
						);
					}

					target.splice(index, index === target.length ? 0 : 1, value as Item);
					return true;
				}

				return Reflect.set(target, property, value, receiver);
			},
		});
	}

	override push(...items: Array<Item>): number {
		if (items.length) {
			this[ApiSymbol].ins(
				this.length,
				(items as Array<JsonValue>).map(toNodeBuilder),
			);
		}
		return applyNativeMutation(this, () => super.push(...items));
	}

	override splice(
		start: number,
		...args: [deleteCount?: number, ...items: Array<Item>]
	): Array<Item> {
		const [deleteCount, ...items] = args;
		const normalizedStart = normalizeStart(start, this.length);
		const normalizedDeleteCount =
			args.length === 0
				? this.length - normalizedStart
				: normalizeDeleteCount(normalizedStart, deleteCount, this.length);

		if (items.length === 1 && deleteCount === 1) {
			this[ApiSymbol].upd(
				normalizedStart,
				toNodeBuilder(items[0] as JsonValue),
			);
		} else {
			if (normalizedDeleteCount) {
				this[ApiSymbol].del(normalizedStart, normalizedDeleteCount);
			}
			if (items.length) {
				this[ApiSymbol].ins(
					normalizedStart,
					(items as Array<JsonValue>).map(toNodeBuilder),
				);
			}
		}

		return applyNativeMutation(this, () =>
			args.length === 0
				? super.splice(start)
				: items.length === 0
					? super.splice(start, normalizedDeleteCount)
					: super.splice(start, normalizedDeleteCount, ...items),
		);
	}

	override pop(): Item | undefined {
		if (!this.length) {
			return undefined;
		}
		this[ApiSymbol].del(this.length - 1, 1);
		return super.pop();
	}

	override shift(): Item | undefined {
		if (!this.length) {
			return undefined;
		}
		this[ApiSymbol].del(0, 1);
		return applyNativeMutation(this, () => super.shift());
	}

	override unshift(...items: Array<Item>): number {
		if (items.length) {
			this[ApiSymbol].ins(0, (items as Array<JsonValue>).map(toNodeBuilder));
			applyNativeMutation(this, () => super.unshift(...items));
		}
		return items.length;
	}

	override reverse(): Array<Item> {
		const reversed = Array.from(this).reverse();
		this.replaceAll(reversed);
		applyNativeMutation(this, () => super.splice(0, this.length, ...reversed));
		return this;
	}

	override sort(compareFn?: (a: Item, b: Item) => number): this {
		const sorted = Array.from(this).sort(compareFn);
		this.replaceAll(sorted);
		applyNativeMutation(this, () => super.splice(0, this.length, ...sorted));
		return this;
	}

	override fill(value: Item, start?: number, end?: number): this {
		const filled = Array.from(this).fill(value, start, end);
		this.replaceAll(filled);
		applyNativeMutation(this, () => super.splice(0, this.length, ...filled));
		return this;
	}

	override copyWithin(target: number, start: number, end?: number): this {
		const copied = Array.from(this).copyWithin(target, start, end);
		this.replaceAll(copied);
		applyNativeMutation(this, () => super.splice(0, this.length, ...copied));
		return this;
	}

	insert(start: number, items: Array<Item>): Array<Item> {
		return this.splice(start, 0, ...items);
	}

	delete(start: number, deleteCount = 1): Array<Item> {
		return this.splice(start, deleteCount);
	}

	replaceAll(items: Array<Item>): void {
		if (this.length) {
			this[ApiSymbol].del(0, this.length);
		}
		if (items.length) {
			this[ApiSymbol].ins(0, (items as Array<JsonValue>).map(toNodeBuilder));
		}
	}
}

function applyNativeMutation<Item, Result>(
	pulseArray: PulseArray<Item>,
	mutation: () => Result,
): Result {
	pulseArray[IsApplyingNativeMutation] = true;
	try {
		return mutation();
	} finally {
		pulseArray[IsApplyingNativeMutation] = false;
	}
}

function isArrayIndex(property: string): boolean {
	const index = Number(property);
	return (
		Number.isInteger(index) &&
		index >= 0 &&
		index < 2 ** 32 - 1 &&
		String(index) === property
	);
}

function normalizeLength(length: unknown): number {
	const numericLength = Number(length);
	const normalizedLength = numericLength >>> 0;
	if (!Number.isFinite(numericLength) || normalizedLength !== numericLength) {
		throw new RangeError("Invalid array length");
	}
	return normalizedLength;
}

function normalizeStart(start: number, length: number): number {
	const integerStart = Math.trunc(start) || 0;
	if (integerStart < 0) {
		return Math.max(length + integerStart, 0);
	}
	return Math.min(integerStart, length);
}

function normalizeDeleteCount(
	start: number,
	deleteCount: number | undefined,
	length: number,
): number {
	const integerDeleteCount = Math.trunc(deleteCount ?? 0) || 0;
	return Math.min(Math.max(integerDeleteCount, 0), length - start);
}
