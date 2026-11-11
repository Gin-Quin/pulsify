import type { CoreNode } from "../core/model.js";
import { pulsify } from "../utilities/pulsify.js";
import type { ProxyContext } from "./ProxyContext.js";
import type { Pulsify } from "../utilities/pulsify.js";
import type { PulseSnapshot } from "./Pulse.js";

/** A codec tuple preserves its positional types and native tuple assignability. */
export type PulseTuple<Values extends readonly unknown[]> = {
	[Key in keyof Values]: Pulsify<Values[Key]>;
};

export type PulseArray<Item> = Array<Item>;

export type PulseArrayOperations<Values extends unknown[]> = {
	replaceAll(items: Values): void;
} & (number extends Values["length"]
	? {
			insert(start: number, items: Values): PulseSnapshot<Values>;
			delete(start: number, count?: number): PulseSnapshot<Values>;
			/** Move a block to its final index, preserving element identity. */
			move(from: number, to: number, count?: number): void;
		}
	: {});

/** Extra helpers live outside the value type so plain arrays remain assignable. */
export function arrayOperations<Values extends unknown[]>(
	array: Values,
): PulseArrayOperations<Values> {
	const insert: unknown = Reflect.get(array, "insert");
	const remove: unknown = Reflect.get(array, "delete");
	const replaceAll: unknown = Reflect.get(array, "replaceAll");
	if (
		!Array.isArray(array) ||
		typeof insert !== "function" ||
		typeof remove !== "function" ||
		typeof replaceAll !== "function"
	)
		throw new TypeError("arrayOperations requires a collaborative pulse array");
	return {
		insert,
		delete: remove,
		move: Reflect.get(array, "move"),
		replaceAll,
	} as unknown as PulseArrayOperations<Values>;
}
function integer(value: number): number {
	return Math.trunc(Number(value)) || 0;
}
function index(value: number, length: number): number {
	const n = integer(value);
	return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
}
function arrayIndex(key: PropertyKey): number | undefined {
	if (typeof key !== "string") return;
	const n = Number(key);
	return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key
		? n
		: undefined;
}
export function createArrayProxy(
	node: CoreNode,
	context: ProxyContext,
): PulseArray<unknown> {
	const length = () => {
		context.assertActive();
		if (!context.meta.model.isAttached(node))
			throw new TypeError("This pulse array has been replaced or removed");
		return node.visible.length;
	};
	const item = (i: number) => {
		const entry = node.visible[i];
		if (!entry) return undefined;
		const layout = node.layout;
		return pulsify(
			entry.value,
			entry.child,
			context,
			layout?.kind === "tuple" ? layout.elements?.[i] : layout?.element,
		);
	};
	let proxy: PulseArray<unknown>;
	const snapshot = () => Array.from({ length: length() }, (_, i) => item(i));
	const splice = (start: number, args: [number?, ...unknown[]]) => {
		const size = length();
		const from = index(start, size);
		const count = args.length
			? Math.min(Math.max(integer(args[0] ?? 0), 0), size - from)
			: size - from;
		return context.meta.model.splice(node, from, count, args.slice(1));
	};
	const replaceAll = (items: unknown[]) => {
		splice(0, [length(), ...items]);
	};
	const methods: Record<string, (...args: any[]) => unknown> = {
		splice: (...args: [number?, number?, ...unknown[]]) =>
			args.length
				? splice(args[0]!, args.slice(1) as [number?, ...unknown[]])
				: [],
		push: (...items: unknown[]) => {
			const size = length();
			context.meta.model.splice(node, size, 0, items);
			return node.visible.length;
		},
		pop: () => (length() ? splice(length() - 1, [1])[0] : undefined),
		shift: () => (length() ? splice(0, [1])[0] : undefined),
		unshift: (...items: unknown[]) => {
			length();
			context.meta.model.splice(node, 0, 0, items);
			return node.visible.length;
		},
		reverse: () => {
			replaceAll(snapshot().reverse());
			return proxy;
		},
		sort: (compare?: (a: unknown, b: unknown) => number) => {
			replaceAll(snapshot().sort(compare));
			return proxy;
		},
		fill: (value: unknown, start?: number, end?: number) => {
			replaceAll(snapshot().fill(value, start, end));
			return proxy;
		},
		copyWithin: (target: number, start: number, end?: number) => {
			replaceAll(snapshot().copyWithin(target, start, end));
			return proxy;
		},
		insert: (start: number, items: unknown[]) => splice(start, [0, ...items]),
		delete: (start: number, count = 1) => splice(start, [count]),
		move: (from: number, to: number, count = 1) => {
			length();
			context.meta.model.move(node, from, to, count);
		},
		replaceAll,
	};
	proxy = new Proxy([], {
		get(target, key, receiver) {
			if (key === "length") return length();
			const i = arrayIndex(key);
			if (i !== undefined) return i < length() ? item(i) : undefined;
			if (typeof key === "string" && Object.hasOwn(methods, key))
				return methods[key];
			return Reflect.get(target, key, receiver);
		},
		set(_target, key, value) {
			if (key === "length") {
				const n = Number(value);
				if (!Number.isInteger(n) || n < 0 || n > length())
					throw new RangeError(
						"Pulse arrays cannot contain holes or grow through length",
					);
				splice(n, [length() - n]);
				return true;
			}
			const i = arrayIndex(key);
			if (i === undefined)
				throw new TypeError("Only array indices can be assigned");
			if (i > length())
				throw new RangeError("Pulse arrays cannot contain holes");
			splice(i, [i < length() ? 1 : 0, value]);
			return true;
		},
		deleteProperty() {
			throw new TypeError("Use splice to remove array elements");
		},
		has(target, key) {
			const i = arrayIndex(key);
			return i === undefined ? Reflect.has(target, key) : i < length();
		},
		ownKeys() {
			return [
				...Array.from({ length: length() }, (_, i) => String(i)),
				"length",
			];
		},
		getOwnPropertyDescriptor(target, key) {
			if (key === "length")
				return {
					...Reflect.getOwnPropertyDescriptor(target, "length")!,
					value: length(),
				};
			const i = arrayIndex(key);
			return i !== undefined && i < length()
				? {
						configurable: true,
						enumerable: true,
						writable: true,
						value: item(i),
					}
				: undefined;
		},
		defineProperty() {
			throw new TypeError("Pulse array elements must be assigned");
		},
		setPrototypeOf() {
			return false;
		},
		preventExtensions() {
			return false;
		},
	}) as unknown as PulseArray<unknown>;
	return proxy;
}
