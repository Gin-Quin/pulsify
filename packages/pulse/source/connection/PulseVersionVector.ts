import { PulseError } from "../protocol/errors.js";
import { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";

/** Exclusive ends of causally complete, immutable patch segments. Sorted by sid. */
export type PulseVersionVector = Array<[sid: number, clock: number]>;
export { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";

export function validateVector(vv: PulseVersionVector): void {
	if (!Array.isArray(vv) || vv.length > MAX_VECTOR_ENTRIES)
		throw new PulseError("INVALID_MESSAGE", "Invalid version vector");
	let previous = -1;
	for (const entry of vv) {
		if (!Array.isArray(entry) || entry.length !== 2)
			throw new PulseError("INVALID_MESSAGE", "Invalid vector entry");
		const [sid, clock] = entry;
		if (
			!Number.isSafeInteger(sid) ||
			sid < 0 ||
			sid <= previous ||
			!Number.isSafeInteger(clock) ||
			clock < 1
		)
			throw new PulseError(
				"INVALID_MESSAGE",
				"Vector must have unique, sorted actors and positive clocks",
			);
		previous = sid;
	}
}

export function vectorCovers(
	have: PulseVersionVector,
	required: PulseVersionVector,
): boolean {
	const clocks = new Map(have);
	return required.every(([sid, clock]) => (clocks.get(sid) ?? 0) >= clock);
}

export function mergeVectors(
	a: PulseVersionVector,
	b: PulseVersionVector,
): PulseVersionVector {
	const result = new Map(a);
	for (const [sid, clock] of b)
		result.set(sid, Math.max(result.get(sid) ?? 0, clock));
	const vv = [...result].sort((x, y) => x[0] - y[0]);
	validateVector(vv);
	return vv;
}
