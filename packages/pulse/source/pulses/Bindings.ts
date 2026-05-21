import type { IsSameType } from "../utilities/IsSameType";

export type Binding<Data, Value> = {
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
	return new Proxy(data, {
		get(target, prop, receiver) {
			if (prop in bindings) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding) {
					return binding.get(target);
				}
			}
			return Reflect.get(target, prop, receiver);
		},
		set(target, prop, value, receiver) {
			if (prop in bindings) {
				const binding = bindings[prop as keyof typeof bindings];
				if (binding) {
					binding.set(target, value);
					return true;
				}
			}
			return Reflect.set(target, prop, value, receiver);
		},
	}) as Data & Model;
}

// usage example
/*
type Data = {
	name: string;
	version: number;
	versionV2: string;
	versionV3: [number, string];
};

type View = {
	name: string;
	version: [number, string];
};

const materializer: Materializer<Data, View> = (data) => ({
	get name() {
		return data.name;
	},
	set name(value: string) {
		data.name = value;
	},
	get version() {
		return data.versionV3;
	},
	set version(value: [number, string]) {
		data.versionV3 = value;
	},
});
*/
