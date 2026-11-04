import type { ArrApi } from "json-joy/lib/json-crdt/index.js";
import { pulsify } from "../utilities/pulsify.js";
import { toNodeBuilder } from "../utilities/toNodeBuilder.js";
import type { ProxyContext } from "./ProxyContext.js";

export type PulseArray<Item> = Array<Item> & {
	insert(start: number, items: Item[]): Item[];
	delete(start: number, count?: number): Item[];
	replaceAll(items: Item[]): void;
};
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
	api: ArrApi,
	context: ProxyContext,
): PulseArray<unknown> {
	const length = () => {
		if (!context.meta.model.index.get(api.node.id))
			throw new TypeError("This pulse array has been replaced or removed");
		return api.length();
	};
	const item = (i: number) => pulsify(api.get(i), context);
	let proxy: PulseArray<unknown>;
	const snapshot = () => Array.from({ length: length() }, (_, i) => item(i));
	const splice = (start: number, args: [number?, ...unknown[]]) => {
		const size = length();
		const from = index(start, size);
		const count = args.length
			? Math.min(Math.max(integer(args[0] ?? 0), 0), size - from)
			: size - from;
		const values = args.slice(1).map((value) => toNodeBuilder(value));
		const removed = Array.from({ length: count }, (_, i) =>
			structuredClone(api.get(from + i).view()),
		);
		if (count || values.length)
			context.mutate((builder) => {
				if (count === 1 && values.length === 1)
					builder.updArr(
						api.node.id,
						api.node.getId(from)!,
						builder.json(values[0]),
					);
				else {
					if (count)
						builder.del(api.node.id, api.node.findInterval(from, count)!);
					if (values.length)
						builder.insArr(
							api.node.id,
							from === 0 ? api.node.id : api.node.find(from - 1)!,
							values.map((value) => builder.json(value)),
						);
				}
			});
		return removed;
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
			splice(length(), [0, ...items]);
			return length();
		},
		pop: () => (length() ? splice(length() - 1, [1])[0] : undefined),
		shift: () => (length() ? splice(0, [1])[0] : undefined),
		unshift: (...items: unknown[]) => {
			splice(0, [0, ...items]);
			return length();
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
