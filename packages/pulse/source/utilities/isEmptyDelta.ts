import type { Delta } from "json-joy/lib/json-crdt/delta/Delta.js";

export function isEmptyDelta(delta: Delta) {
	return delta.batch.patches.length === 0;
}
