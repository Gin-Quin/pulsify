import type { Actor } from "./Actor";

/**
 * A single entry is an event point with a value associated with it.
 */
export type Entry<T> = Actor.Event & {
	value: T;
};

/**
 * An entry is list of subsequent SingleEntry with the same actorId.
 */
export type Entries<T> = Actor.Event & {
	content: Array<T>;
};
