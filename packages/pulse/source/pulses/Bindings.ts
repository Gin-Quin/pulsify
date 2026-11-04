import type { IsSameType } from "../utilities/IsSameType.js";

export type Binding<Data, Value> = {
	/** Stored field consumed by a direct alias. */
	readonly sourceKey?: keyof Data;
	get(data: Data): Value;
	set(data: Data, value: Value): void;
};

export type Bindings<Data extends object, Model extends object> = {
	[Key in OptionalBindingKeys<Data, Model>]?: Binding<Data, Model[Key]>;
} & {
	[Key in RequiredBindingKeys<Data, Model>]: Binding<Data, Model[Key]>;
};

type OptionalBindingKeys<Data extends object, Model extends object> = {
	[Key in keyof Model]: Key extends keyof Data
		? IsSameType<Data[Key], Model[Key]> extends true
			? Key
			: never
		: never;
}[keyof Model];

type RequiredBindingKeys<Data extends object, Model extends object> = Exclude<
	keyof Model,
	OptionalBindingKeys<Data, Model>
>;

export function bind<Data extends object, Model extends object>(
	data: Data,
	bindings: Bindings<Data, Model>,
): Data & Model {
	const hidden = new Set<PropertyKey>();
	for (const [key, binding] of Object.entries(bindings) as [
		string,
		Binding<Data, unknown>,
	][]) {
		if (
			binding?.sourceKey !== undefined &&
			binding.sourceKey !== key &&
			!Object.hasOwn(bindings, binding.sourceKey)
		)
			hidden.add(binding.sourceKey);
	}
	return new Proxy(data, {
		get(target, prop, receiver) {
			if (Object.hasOwn(bindings, prop)) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding) {
					return binding.get(target);
				}
			}
			return Reflect.get(target, prop, receiver);
		},
		set(target, prop, value, receiver) {
			if (Object.hasOwn(bindings, prop)) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding) {
					binding.set(target, value);
					return true;
				}
			}
			return Reflect.set(target, prop, value, receiver);
		},
		deleteProperty(target, prop) {
			if (Object.hasOwn(bindings, prop)) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding?.sourceKey === undefined)
					throw new TypeError("Derived bindings cannot be deleted");
				return Reflect.deleteProperty(target, binding.sourceKey);
			}
			return Reflect.deleteProperty(target, prop);
		},
		has(target, prop) {
			if (Object.hasOwn(bindings, prop)) {
				const source = bindings[prop as keyof typeof bindings]?.sourceKey;
				return source === undefined || Reflect.has(target, source);
			}
			return !hidden.has(prop) && Reflect.has(target, prop);
		},
		ownKeys(target) {
			return [
				...new Set([
					...Reflect.ownKeys(target).filter((key) => !hidden.has(key)),
					...Reflect.ownKeys(bindings),
				]),
			];
		},
		getOwnPropertyDescriptor(target, prop) {
			if (Object.hasOwn(bindings, prop)) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding)
					return {
						configurable: true,
						enumerable: true,
						writable: true,
						value: binding.get(target),
					};
			}
			return hidden.has(prop)
				? undefined
				: Reflect.getOwnPropertyDescriptor(target, prop);
		},
	}) as Data & Model;
}
