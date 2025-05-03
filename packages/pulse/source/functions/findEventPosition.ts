import { matchActorEvent, type Actor } from "../types/Actor";
import type { Entries } from "../types/Entry";

export type EventPosition = {
	index: number;
	offset: number;
};

export function findEventPosition<T>({
	state,
	left,
	right,
}: {
	state: Array<Entries<T>>;
	left?: Actor.Event;
	right?: Actor.Event;
}): EventPosition | null {
	if (left) {
		const index = state.findIndex(matchActorEvent(left));
		if (index !== -1) {
			return {
				index,
				offset: Number(left.clock - state[index].clock + 1n),
			};
		}
	}

	if (right) {
		const index = state.findIndex(matchActorEvent(right));
		if (index !== -1) {
			return {
				index,
				offset: Number(right.clock - state[index].clock),
			};
		}
	}

	return null;
}
