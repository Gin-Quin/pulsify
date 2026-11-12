import { TreeSymbol } from "./treeSchema.js";

export const RichTextSymbol: unique symbol = Symbol("RichText");
export const RichTextSchemaSymbol: unique symbol = Symbol("RichTextSchema");
export const PulseRefSymbol: unique symbol = Symbol("PulseRef");
export type PreparedValue = {
	value: unknown;
	constants: string[][];
	texts: string[][];
};
export function assertKey(key: PropertyKey): asserts key is string {
	if (
		typeof key !== "string" ||
		!key.isWellFormed() ||
		key === "__proto__" ||
		key === "constructor" ||
		key === "prototype"
	)
		throw new TypeError(`Unsupported property ${String(key)}`);
}
/** Validate and detach once, before a mutation touches either state or history. */
const emptyPaths: string[][] = [];
export function prepareValue(input: unknown): PreparedValue {
	if (
		input === null ||
		input === undefined ||
		typeof input === "boolean" ||
		typeof input === "bigint" ||
		(typeof input === "number" && Number.isFinite(input)) ||
		(typeof input === "string" && input.isWellFormed())
	)
		return {
			value: typeof input === "number" && Object.is(input, -0) ? 0 : input,
			constants: emptyPaths,
			texts: emptyPaths,
		};
	const texts: string[][] = [];
	const ancestors = new Set<object>();
	function clone(value: unknown, path: string[], depth: number): unknown {
		if (depth > 32)
			throw new TypeError("Pulse values may nest at most 32 levels");
		if (
			value === null ||
			value === undefined ||
			typeof value === "boolean" ||
			typeof value === "bigint"
		)
			return value;
		if (typeof value === "string") {
			if (!value.isWellFormed())
				throw new TypeError("Strings must be valid Unicode");
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value))
				throw new TypeError("Numbers must be finite");
			return Object.is(value, -0) ? 0 : value;
		}
		if (typeof value !== "object")
			throw new TypeError(`Unsupported pulse value: ${typeof value}`);
		if (ancestors.has(value))
			throw new TypeError("Pulse values cannot contain cycles");
		ancestors.add(value);
		try {
			if (value instanceof Uint8Array) return new Uint8Array(value);
			if ((value as { [TreeSymbol]?: boolean })[TreeSymbol])
				return clone(
					(value as { snapshot(): unknown }).snapshot(),
					path,
					depth,
				);
			if ((value as { [RichTextSymbol]?: boolean })[RichTextSymbol]) {
				texts.push(path);
				return clone((value as { text: string }).text, path, depth + 1);
			}
			if (Array.isArray(value)) {
				const result = new Array<unknown>(value.length);
				for (let i = 0; i < value.length; i++) {
					if (!(i in value))
						throw new TypeError("Pulse arrays cannot contain holes");
					result[i] = clone(value[i], [...path, String(i)], depth + 1);
				}
				return result;
			}
			if (
				Object.getPrototypeOf(value) !== Object.prototype &&
				Object.getPrototypeOf(value) !== null
			)
				throw new TypeError("Pulse values must be plain objects");
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(value)) {
				assertKey(key);
				result[key] = clone(
					(value as Record<string, unknown>)[key],
					[...path, key],
					depth + 1,
				);
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	}
	return { value: clone(input, [], 0), constants: [], texts };
}
const constantsWithBytes = new WeakSet<object>();
export function freezeConstant(value: unknown): unknown {
	if (value instanceof Uint8Array) return value;
	if (value && typeof value === "object") {
		let binary = false;
		for (const item of Object.values(value)) {
			freezeConstant(item);
			if (
				item instanceof Uint8Array ||
				(item && typeof item === "object" && constantsWithBytes.has(item))
			)
				binary = true;
		}
		if (binary) constantsWithBytes.add(value);
		Object.freeze(value);
	}
	return value;
}
/** Read-only views throw even through Reflect.set; binary leaves stay detached. */
const constantViews = new WeakMap<object, object>();
export function constantView(value: unknown): unknown {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (!value || typeof value !== "object") return value;
	const cached = constantViews.get(value);
	if (cached) return cached;
	const target = Array.isArray(value) ? [] : {};
	const readonly = () => {
		throw new TypeError("Constant pulse values cannot be mutated");
	};
	const proxy = new Proxy(target, {
		get(_target, key) {
			return constantView(Reflect.get(value, key));
		},
		set: readonly,
		deleteProperty: readonly,
		defineProperty: readonly,
		setPrototypeOf: readonly,
		preventExtensions: readonly,
		has(_target, key) {
			return key in value;
		},
		ownKeys() {
			return Reflect.ownKeys(value);
		},
		getOwnPropertyDescriptor(_target, key) {
			if (Array.isArray(value) && key === "length")
				return {
					...Reflect.getOwnPropertyDescriptor(target, "length")!,
					value: value.length,
				};
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
			return descriptor
				? {
						configurable: true,
						enumerable: descriptor.enumerable ?? false,
						writable: false,
						value: constantView(Reflect.get(value, key)),
					}
				: undefined;
		},
	});
	constantViews.set(value, proxy);
	return proxy;
}
export function validatePrepared(value: PreparedValue): void {
	for (const [paths, text] of [
		[value.constants, false],
		[value.texts, true],
	] as const) {
		for (const path of paths) {
			let current = value.value;
			for (const key of path) {
				assertKey(key);
				if (
					!current ||
					typeof current !== "object" ||
					!Object.hasOwn(current, key)
				)
					throw new TypeError("Value marker refers to a missing path");
				current = (current as Record<string, unknown>)[key];
			}
			if (text && typeof current !== "string")
				throw new TypeError("Rich text markers require a string");
		}
	}
}
