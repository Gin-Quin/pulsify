export function isEmptyDelta(delta: { ops: readonly unknown[] }): boolean {
	return delta.ops.length === 0;
}
