import type { Entry } from "../types/Entry"
import type { State } from "../types/State"
import type { Update } from "../types/Update"

export function findLeftRightEntries(
	state: State,
	index: number
): { left?: Entry; right?: Entry } {
	if (index == 0) {
		const firstUpdate = state[0] as Update | undefined
		return {
			right: firstUpdate && {
				actor: firstUpdate.actor,
				clock: firstUpdate.clock,
			},
		}
	} else if (index == state.length) {
		const lastUpdate = state[state.length - 1]
		return {
			left: {
				actor: lastUpdate.actor,
				clock: lastUpdate.clock,
			},
		}
	}

	let start = 0

	for (let offset = 0; offset < state.length; offset++) {
		const update = state[offset]
		const end = update.content.length + start

		if (index > end) {
			start = end
			continue
		}

		const leftClock = update.clock + BigInt(start)
		const left = {
			actor: update.actor,
			clock: leftClock,
		}
		let right: Entry | undefined

		if (index < end) {
			right = {
				actor: update.actor,
				clock: leftClock + 1n,
			}
		} else {
			const nextUpdate = state[offset + 1] as Update | undefined
			right = nextUpdate && {
				actor: nextUpdate.actor,
				clock: nextUpdate.clock,
			}
		}

		return { left, right }
	}

	throw new Error("Index out of bounds.")
}
