import { type ValueUpdate } from "../types/Update"
import { me } from "../values/me"
import { BasePulse } from "./BasePulse"

export class PulseValue<T> extends BasePulse<T> {
	state = Array<ValueUpdate<T>>()

	/**
	 * 
	 */
	static 

	}

	/**
	 * Merge updates into the state.
	 * This is where we handle conflicts, add pending udpates, etc.
	 */
	applyUpdates(updates: Array<ValueUpdate<T>>): this {
		const lastUpdate = this.state.at(-1)

		for (const update of updates) {
			const index = this.state.findIndex(state => state.actor === update.actor)
			if (index === -1) {
				this.state.push(update)
			} else {
				this.state[index] = update
			}
		}

		return this
	}

	/**
	 * Set a new value to the Pulse.
	 */
	set(value: T, actor = me): this {
		this.value = value

		const lastUpdate = this.state.at(-1)

		const update: ValueUpdate<T> = {
			actor: actor.id,
			clock: actor.clock++,
			left: lastUpdate && {
				actor: lastUpdate.actor,
				clock: lastUpdate.clock,
			},
			content: [value],
		}
		this.applyUpdates([update])

		return this
	}
}
