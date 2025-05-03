import { bunker, debunker } from "@digitak/bunker";
import type { Actor } from "./Actor";
import type { Entries, Entry } from "./Entry";

/**
 * The position of an update, relative to other updates.
 */
interface UpdatePosition {
	key?: string; // for objects and maps
	left?: Actor.Event;
	right?: Actor.Event; // for arrays
}

/**
 * An update represents an entry with the data associated with it.
 */
export interface Update<T> extends Entries<T>, UpdatePosition {}

/**
 * An atomic update represents a single entry at a specific position.
 */
export interface AtomicUpdate<T> extends Entry<T>, UpdatePosition {}

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
