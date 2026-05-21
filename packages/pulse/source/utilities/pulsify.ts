import type { JsonNodeApi } from "json-joy/lib/json-crdt/model/api/types";
import { PulseArray } from "pulse/pulses/PulseArray";
import { PulseObject } from "pulse/pulses/PulseObject";
import type { PulseValue } from "pulse/pulses/PulseValue";
import type { JsonValue } from "pulse/utilities/JsonValue";
import type { Struct } from "pulse/utilities/Struct";
import { type Tuple, isTuple } from "pulse/utilities/Tuple";

export type Pulsify<Value> = Value extends Tuple<readonly unknown[]>
	? Value
	: Value extends Array<infer Item>
		? PulseArray<Pulsify<Item>>
		: Value extends Struct<Record<string, unknown>>
			? Value
			: Value extends Record<string, unknown>
				? PulseObject<{ [Key in keyof Value]: Pulsify<Value[Key]> }>
				: Value;

/**
 * Take a json value and a model, and return the JsonJoy node
 */
export function pulsify<Value>(
	api: JsonNodeApi<any>,
	value: Value & JsonValue,
): Pulsify<Value> {
	console.log({ api, value });
	switch (typeof value) {
		case "number":
		case "string":
		case "boolean":
		case "undefined":
			return value as Pulsify<Value>;
		case "object":
			if (value === null) {
				return value as Pulsify<Value>;
			} else if (Array.isArray(value)) {
				if (isTuple(value)) {
					return value as Pulsify<Value>;
				} else {
					return new PulseArray(
						api.asArr(),
						value.map((item, index) => pulsify(api.asArr().get(index), item)),
					) as Pulsify<Value>;
				}
			} else {
				const pulseObject: Record<string, PulseValue> = {};
				for (const [key, item] of Object.entries(value)) {
					pulseObject[key] = pulsify(api.asObj().get(key), item);
				}
				return new PulseObject(api.asObj(), pulseObject) as Pulsify<Value>;
			}
		default:
			throw new Error(`Unsupported JSON value: ${typeof value}`);
	}
}
