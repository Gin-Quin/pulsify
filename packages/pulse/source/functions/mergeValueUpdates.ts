import type { ValueUpdate } from "../types/Update"

/**
 * Merge updates together.
 * If all updates could be merged, return an array with one update.
 * If not, return an array that contains the pending updates as well.
 */
export function mergeValueUpdates<T>(
	updates: Array<ValueUpdate<T>>,
	{ inPlace = false }
): Array<ValueState<T>> {
	const result = Array<Array<ValueUpdate<T>>>()

	for (const update of updates) {
		const { left } = update

		if (!left) {
			result.splice(0, 0, update)
		} else {
			const index = result.findIndex(state => state.actor === left.actor && state.clock === left.clock)
			if (index === -1) {
				result.push(update)
			} else {
				if (left.actor == update.actor) {
					// same actor, so we can merge
				} else {
					// different actors, so we can't merge
					result.
				}
				result[index] = update
			}
		}
	}
}

