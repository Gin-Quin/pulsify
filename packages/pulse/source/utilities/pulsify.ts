import { constantView } from "../core/values.js";
import type { CoreNode } from "../core/model.js";
import { createTextProxy, type RichText } from "../core/richText.js";
import {
	createArrayProxy,
	type PulseArray,
	type PulseTuple,
} from "../pulses/PulseArray.js";
import { createObjectProxy } from "../pulses/PulseObject.js";
import type { ProxyContext } from "../pulses/ProxyContext.js";
import type { Struct } from "./Struct.js";
import type { Tuple } from "./Tuple.js";
import type { IsSameType } from "./IsSameType.js";

type PulseBytes<Value extends Uint8Array> = IsSameType<
	Value,
	Readonly<Value>
> extends true
	? Readonly<Uint8Array>
	: Uint8Array;

export type Pulsify<Value> = Value extends RichText
	? RichText
	: Value extends Uint8Array
		? PulseBytes<Value>
		: Value extends Tuple<readonly unknown[]>
			? Value
			: Value extends Struct<Record<string, unknown>>
				? Value
				: Value extends Array<infer Item>
					? number extends Value["length"]
						? PulseArray<Pulsify<Item>>
						: PulseTuple<Value>
					: Value extends object
						? { [Key in keyof Value]: Pulsify<Value[Key]> }
						: Value;

export function pulsify(
	value: unknown,
	node: CoreNode | undefined,
	context: ProxyContext,
): any {
	if (!node)
		return value instanceof Uint8Array
			? new Uint8Array(value)
			: constantView(value);
	if (node.proxy) return node.proxy;
	if (node.kind === "text")
		node.proxy = createTextProxy(
			node,
			context.meta.model,
			context.assertActive,
		);
	else if (node.kind === "array") node.proxy = createArrayProxy(node, context);
	else node.proxy = createObjectProxy(() => node, context);
	return node.proxy;
}
