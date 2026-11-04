import type { ObjApi } from "json-joy/lib/json-crdt/index.js";
import { pulsify } from "../utilities/pulsify.js";
import { toNodeBuilder } from "../utilities/toNodeBuilder.js";
import { PulseMetaSymbol } from "./PulseMeta.js";
import type { ProxyContext } from "./ProxyContext.js";

export type PulseObject<Value extends object> = Value;
const managed = new Set(["id", "kind", "version", "generation"]);
export function assertProperty(key: PropertyKey): asserts key is string {
	if (
		typeof key !== "string" ||
		!key.isWellFormed() ||
		["__proto__", "constructor", "prototype"].includes(key)
	)
		throw new TypeError(`Unsupported property ${String(key)}`);
}
export function createObjectProxy(
	getApi: () => ObjApi,
	context: ProxyContext,
	root = false,
): object {
	const attached = () => {
		const api = getApi();
		if (!root && !context.meta.model.index.get(api.node.id))
			throw new TypeError("This pulse object has been replaced or removed");
		return api;
	};
	const view = () =>
		root && !context.meta.loaded
			? {}
			: (attached().view() as Record<string, unknown>);
	return new Proxy(
		{},
		{
			get(_target, key) {
				if (key === PulseMetaSymbol && root) return context.meta;
				if (key === Symbol.toStringTag) return "PulseObject";
				const current = view();
				if (typeof key !== "string" || !Object.hasOwn(current, key))
					return Reflect.get(Object.prototype, key);
				return pulsify(getApi().get(key), context);
			},
			set(_target, key, value) {
				attached();
				assertProperty(key);
				if (root && managed.has(key))
					throw new TypeError(`${key} is managed by Pulsify`);
				const builder = toNodeBuilder(value);
				context.mutate((patch) =>
					patch.insObj(getApi().node.id, [[key, patch.json(builder)]]),
				);
				return true;
			},
			deleteProperty(_target, key) {
				attached();
				assertProperty(key);
				if (root && managed.has(key))
					throw new TypeError(`${key} is managed by Pulsify`);
				if (Object.hasOwn(view(), key))
					context.mutate((patch) =>
						patch.insObj(getApi().node.id, [[key, patch.con(undefined)]]),
					);
				return true;
			},
			has(_target, key) {
				return (key === PulseMetaSymbol && root) || Object.hasOwn(view(), key);
			},
			ownKeys() {
				return Object.keys(view());
			},
			getOwnPropertyDescriptor(_target, key) {
				return Object.hasOwn(view(), key)
					? {
							configurable: true,
							enumerable: true,
							writable: !(root && managed.has(String(key))),
							value: pulsify(getApi().get(String(key)), context),
						}
					: undefined;
			},
			defineProperty() {
				throw new TypeError("Pulse properties must be assigned or deleted");
			},
			setPrototypeOf() {
				return false;
			},
			preventExtensions() {
				return false;
			},
		},
	);
}
