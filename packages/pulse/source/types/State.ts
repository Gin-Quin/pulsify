import type { Actor } from "./Actor";
import type { Entries } from "./Entry";
import type { Update } from "./Update";

export type State<T> = Array<Entries<T>>;

/**
 * Assimilate an update into a state.
 * This does not prevent duplicates, so you should check beforehand if an update has already been assimilated.
 * TODO: handle conflicts in a deterministic way.
 */
export function assimilateUpdate<T>(
	state: State<T>,
	update: Update<T>,
): boolean {
	const { left, right } = update;

	if (!left && !right) {
		// we insert at first position
		if (state.length === 0) {
			state.push({
				actor: update.actor,
				clock: update.clock,
				content: update.content,
			});
		} else if (
			state[0].actor !== update.actor &&
			state[0].clock !== update.clock
		) {
			// TODO: handle conflicts in a deterministic way.
			console.warn(
				"Merge conflict detected between",
				state[0],
				"(present) and",
				update,
				"(incoming).",
			);
		}
		return true;
	}

	const position = findPositionInState(state, { left, right });

	if (!position) {
		return false;
	}

	const entry = state[position.index];

	if (position.offset === 0) {
		// we insert at the left of 'entry'
		state.splice(position.index, 0, {
			actor: update.actor,
			clock: update.clock,
			content: update.content,
		});
	} else if (position.offset === entry.content.length) {
		// we insert at the right of 'entry'
		state.splice(position.index + 1, 0, {
			actor: update.actor,
			clock: update.clock,
			content: update.content,
		});
	} else {
		// we insert at the middle of 'entry'
		state.splice(
			position.index,
			1,
			{
				actor: entry.actor,
				clock: entry.clock,
				content: entry.content.slice(0, position.offset),
			},
			{
				actor: update.actor,
				clock: update.clock,
				content: update.content,
			},
			{
				actor: entry.actor,
				clock: entry.clock + BigInt(position.offset),
				content: entry.content.slice(position.offset),
			},
		);
	}

	return true;
}

/**
 * Find the index of an event in a state.
 */
export function findActorEventIndexInState<T>(
	state: State<T>,
	event: Actor.Event,
): number {
	return state.findLastIndex(
		<T>(entry: Entries<T>) =>
			entry.actor === event.actor &&
			event.clock >= entry.clock &&
			event.clock < entry.clock + BigInt(entry.content.length),
	);
}

/**
 * Find the exact position of an event in a state.
 */
export function findPositionInState<T>(
	state: Array<Entries<T>>,
	{
		left,
		right,
	}: {
		left?: Actor.Event;
		right?: Actor.Event;
	},
): Actor.EventPosition | null {
	if (left) {
		const index = findActorEventIndexInState(state, left);
		if (index !== -1) {
			return {
				index,
				offset: Number(left.clock - state[index].clock + 1n),
			};
		}
	}

	if (right) {
		const index = findActorEventIndexInState(state, right);
		if (index !== -1) {
			return {
				index,
				offset: Number(right.clock - state[index].clock),
			};
		}
	}

	return null;
}
