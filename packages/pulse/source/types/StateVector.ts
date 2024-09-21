import type { Actor } from "./Actor";

export class StateVector extends Map<Actor.Id, Actor.Clock> {}

/**
 * Use and increment an actor's clock in the state vector.
 */
export function useActorClock(
	stateVector: StateVector,
	actor: Actor.Id,
	count: number | bigint,
): Actor.Clock {
	const value = stateVector.get(actor) ?? 0n;
	stateVector.set(actor, value + BigInt(count));
	return value;
}
