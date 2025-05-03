import type { Actor } from "../types/Actor";
import type { Entries } from "../types/Entry";

export function findLeftRightEvents<T>(
	state: Array<Entries<T>>,
	index: number,
): { left?: Actor.Event; right?: Actor.Event } {
	if (index === 0) {
		const firstEntry = state[0] as Entries<T> | undefined;
		return {
			right: firstEntry && {
				actor: firstEntry.actor,
				clock: firstEntry.clock,
			},
		};
	} /* else if (index === state.length) {
		const lastEntry = state[state.length - 1] as Entries<T> | undefined;
		return {
			left: lastEntry && {
				actor: lastEntry.actor,
				clock: lastEntry.clock + BigInt(lastEntry.content.length) - 1n,
			},
		};
	}*/

	let start = 0;

	for (let offset = 0; offset < state.length; offset++) {
		const update = state[offset];
		const end = start + update.content.length;

		if (index > end) {
			start = end;
			continue;
		}

		const leftClock = update.clock + BigInt(index - start - 1);
		const left = {
			actor: update.actor,
			clock: leftClock,
		};
		let right: Actor.Event | undefined;

		if (index < end) {
			right = {
				actor: update.actor,
				clock: leftClock + 1n,
			};
		} else {
			const nextUpdate = state[offset + 1] as Entries<T> | undefined;
			right = nextUpdate && {
				actor: nextUpdate.actor,
				clock: nextUpdate.clock,
			};
		}

		return { left, right };
	}

	throw new Error("Index out of bounds.");
}
