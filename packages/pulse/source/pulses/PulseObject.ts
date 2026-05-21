import type { ObjApi } from "json-joy";
import { toNodeBuilder } from "pulse/utilities/toNodeBuilder";

export type PulseObject<Values extends Record<string, unknown>> = InstanceType<
	typeof PulseObject<Values>
>;

export const PulseObject = class PulseObject<
	Value extends Record<string, unknown>,
> {
	constructor(api: ObjApi, object: Value) {
		// biome-ignore lint/correctness/noConstructorReturn: Derived constructors may return an object.
		return new Proxy(object, {
			get(target, prop, receiver) {
				return Reflect.get(target, prop, receiver);
			},
			set(target, prop, value, receiver) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
				const isSetter = descriptor != null && "set" in descriptor;
				const isFunction =
					descriptor != null &&
					"value" in descriptor &&
					typeof descriptor.value === "function";

				if (
					(typeof prop !== "string" || prop[0] !== "#") &&
					!isSetter &&
					!isFunction
				) {
					api.set({ [prop]: toNodeBuilder(value) });
				}

				return Reflect.set(target, prop, value, receiver);
			},
		}) as any;
	}
} as {
	new <Value extends Record<string, unknown>>(
		api: ObjApi,
		object: Value,
	): Value;
};
