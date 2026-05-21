import type { NodeBuilder } from "json-joy";
import { s } from "json-joy/lib/json-crdt";
import type { JsonValue } from "pulse/utilities/JsonValue";
import { isStruct } from "pulse/utilities/Struct";
import { isTuple } from "pulse/utilities/Tuple";

export function toNodeBuilder<Value extends JsonValue>(
	value: Value,
): NodeBuilder {
	switch (typeof value) {
		case "number":
		case "string":
		case "boolean":
			return s.con(value);
		case "object":
			if (value === null) {
				return s.con(value);
			} else if (Array.isArray(value)) {
				if (isTuple(value)) {
					return s.con(value);
				} else {
					return s.arr(value.map(toNodeBuilder));
				}
			} else {
				if (isStruct(value)) {
					return s.con(value);
				} else {
					const nodeBuilder: Record<string, NodeBuilder> = {};
					for (const [key, val] of Object.entries(value)) {
						nodeBuilder[key] = toNodeBuilder(val);
					}
					return s.obj(nodeBuilder);
				}
			}
		default:
			throw new Error(`Unsupported JSON value: ${typeof value}`);
	}
}
