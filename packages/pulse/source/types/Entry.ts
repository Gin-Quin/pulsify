import type { Actor } from "./Actor";

/**
 * An entry is an event point with the content associated with it.
 */
export type Entry<T> = Actor.Event & {
	content: Array<T>;
};
