// Benchmark-only json-joy graph construction, preserved from the pre-rewrite engine.
import type { NodeBuilder } from "json-joy";
import { s } from "json-joy/lib/json-crdt/index.js";
import { assertProperty } from "../packages/pulse/source/pulses/PulseObject.js";

export function toNodeBuilder(
	value: unknown,
	ancestors = new Set<object>(),
	depth = 0,
): NodeBuilder {
	if (depth > 32)
		throw new TypeError("Pulse values may nest at most 32 levels");
	switch (typeof value) {
		case "undefined":
		case "boolean":
			return s.con(value);
		case "string":
			if (!value.isWellFormed())
				throw new TypeError("Strings must be valid Unicode");
			return s.con(value);
		case "number":
			if (!Number.isFinite(value))
				throw new TypeError("Numbers must be finite");
			return s.con(value);
		case "object": {
			if (value === null) return s.con(null);
			if (ancestors.has(value))
				throw new TypeError("Pulse values cannot contain cycles");
			ancestors.add(value);
			try {
				if (Array.isArray(value)) {
					const items: NodeBuilder[] = [];
					for (let i = 0; i < value.length; i++) {
						if (!(i in value))
							throw new TypeError("Pulse arrays cannot contain holes");
						items.push(toNodeBuilder(value[i], ancestors, depth + 1));
					}
					return s.arr(items);
				}
				if (
					Object.getPrototypeOf(value) !== Object.prototype &&
					Object.getPrototypeOf(value) !== null
				)
					throw new TypeError("Pulse values must be plain objects");
				const entries: Record<string, NodeBuilder> = {};
				for (const [key, item] of Object.entries(value)) {
					assertProperty(key);
					entries[key] = toNodeBuilder(item, ancestors, depth + 1);
				}
				return s.obj(entries);
			} finally {
				ancestors.delete(value);
			}
		}
		default:
			throw new TypeError(`Unsupported pulse value: ${typeof value}`);
	}
}
