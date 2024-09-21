import { bunker, debunker } from "@digitak/bunker";
import type { Actor } from "./Actor";
import type { Entry } from "./Entry";

/**
 * An update represents an entry with the data associated with it.
 */
export type Update<T> = Entry<T> & {
	key?: string; // only used for object updates
	left?: Actor.Event;
	right?: Actor.Event;
};

export type AtomicUpdate<T> = Actor.Event & {
	content: T;
	key?: string; // only used for object updates
	left?: Actor.Event;
	right?: Actor.Event;
};

/**
 * Encode an update into a byte array.
 */
export function encodeUpdate<T>(update: Update<T>): Uint8Array {
	return bunker(update);
}

/**
 * Decode an update from a byte array.
 */
export function decodeUpdate<T>(update: Uint8Array): Update<T> {
	return debunker(update) as Update<T>;
}
