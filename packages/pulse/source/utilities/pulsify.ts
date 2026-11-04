import type { NodeApi } from "json-joy/lib/json-crdt/model/api/nodes.js";
import { createArrayProxy, type PulseArray } from "../pulses/PulseArray.js";
import { createObjectProxy } from "../pulses/PulseObject.js";
import type { ProxyContext } from "../pulses/ProxyContext.js";
import type { Struct } from "./Struct.js";
import type { Tuple } from "./Tuple.js";

export type Pulsify<Value> = Value extends Tuple<readonly unknown[]>
	? Value
	: Value extends Struct<Record<string, unknown>>
		? Value
		: Value extends Array<infer Item>
			? PulseArray<Pulsify<Item>>
			: Value extends object
				? { [Key in keyof Value]: Pulsify<Value[Key]> }
				: Value;

export function pulsify(
	api: Pick<NodeApi<any>, "node" | "view" | "asArr" | "asObj">,
	context: ProxyContext,
): any {
	const value = api.view();
	if (value === null || typeof value !== "object") return value;
	const cached = context.cache.get(api.node);
	if (cached) return cached;
	let proxy: unknown;
	if (api.asArr(true)) proxy = createArrayProxy(api.asArr(), context);
	else if (api.asObj(true))
		proxy = createObjectProxy(() => api.asObj(), context);
	else proxy = freezeConstant(structuredClone(value));
	context.cache.set(api.node, proxy);
	return proxy;
}
function freezeConstant(value: unknown): unknown {
	if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
		for (const item of Object.values(value)) freezeConstant(item);
		Object.freeze(value);
	}
	return value;
}
