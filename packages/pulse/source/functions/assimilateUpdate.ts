import type { Entry } from "../types/Entry"
import type { Update } from "../types/Update"
import { matchEntry } from "./matchEntry"

export enum AssimilateUpdateError {
	CantAssimilate = -2,
	AlreadyAssimilated = -1,
}

/**
 * Assimilate an update into a state at the given index.
 */
export function assimilateUpdate(state: Array<Update>, update: Update): number {
	const { left, right } = update

	if (!left && !right) {
		// we insert at first position
		if (state.length == 0) {
			state.push(update)
		} else if (state[0].actor != update.actor && state[0].clock != update.clock) {
			console.warn(
				"Merge conflict detected between",
				state[0],
				"(present) and",
				update,
				"(incoming)."
			)
			state.splice(0, 0, update)
		}
		return 0
	}

	const neighborEntry = (left ?? right) as Entry
	const matchNeighbor = matchEntry(neighborEntry)
	const index = state.findLastIndex(matchNeighbor)

	if (index === -1) {
		// cannot assimilate the entry
		return AssimilateUpdateError.CantAssimilate
	}

	const insertionIndex = left ? index + 1 : index

	// try to merge with the left update
	if (insertionIndex > 0) {
		const leftUpdate = state[insertionIndex - 1]
		const leftClockEnd = leftUpdate.clock + BigInt(leftUpdate.content.length)

		if (
			leftUpdate.actor == update.actor &&
			update.clock >= leftUpdate.clock &&
			update.clock <= leftClockEnd
		) {
			// left merging
			const startOffset = Number(leftClockEnd - update.clock)

			if (startOffset >= update.content.length) {
				console.warn("Left merge: Update is already assimilated.")
				return AssimilateUpdateError.AlreadyAssimilated
			} else if (startOffset > 0) {
				console.warn("Left merge: Update was partially assimilated.")
			}

			for (let offset = startOffset; offset < update.content.length; offset++) {
				leftUpdate.content[leftUpdate.content.length] = update.content[offset]
			}

			return insertionIndex
		}
	}

	// try to merge with the right update
	if (insertionIndex < state.length) {
		const rightUpdate = state[insertionIndex]

		if (rightUpdate.actor == update.actor && rightUpdate.clock == update.clock) {
			// right merging
			const startOffset = Number(rightUpdate.clock + BigInt(rightUpdate.content.length))

			if (startOffset >= update.content.length) {
				console.warn("Right merge: Update is already assimilated.")
				return AssimilateUpdateError.AlreadyAssimilated
			} else if (startOffset > 0) {
				console.warn("Right merge: Update was partially assimilated.")
			}

			for (let offset = startOffset; offset < update.content.length; offset++) {
				rightUpdate.content[rightUpdate.content.length] = update.content[offset]
			}

			return insertionIndex
		}
	}

	// TODO: Check duplicate from the right
	state.splice(insertionIndex, 0, update)

	return insertionIndex
}
