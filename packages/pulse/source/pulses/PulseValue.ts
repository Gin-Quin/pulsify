import type { ValueState } from "../types/State"
import { type ValueUpdate } from "../types/Update"
import { me } from "../values/me"
import { BasePulse } from "./BasePulse"

export class PulseValue<T> extends BasePulse<T> {
	state: ValueState<T> = []
	pendingStates: Array<Array<ValueUpdate<T>>> = []
	pendingUpdates: Array<ValueUpdate<T>> = []

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

		if (
			lastUpdate &&
			lastUpdate.actor == update.actor &&
			lastUpdate.clock + BigInt(lastUpdate.content.length) == update.clock
		) {
			// if the update is the same as the last update, we merge it
			lastUpdate.content.push(value)
		} else {
			// otherwise, we push the update to the state
			this.state.push(update)
		}

		this.emit("update", update)

		return this
	}
}
