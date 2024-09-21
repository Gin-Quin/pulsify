import type { Entry } from "./Entry";

/**
 * An actor is an entity that is able to update pulses.
 */
export namespace Actor {
	export type Id = bigint;
	export type Clock = bigint;
	export type Event = {
		actor: Id;
		clock: Clock;
	};
	export type EventPosition = {
		index: number;
		offset: number;
	};
}

/**
 * Create a random actor ID.
 * The ID can be serializable into a 5-byte array.
 */
export function createRandomActorId(): bigint {
	const array = new Uint8Array(5);
	crypto.getRandomValues(array);
	return decodeActorId(array);
}

/**
 * Encode an actor ID into a 5-byte array.
 */
export function encodeActorId(id: bigint | number): Uint8Array {
	const idNumber = Number(id);
	const array = new Uint8Array(5);
	for (let i = 0; i < 5; i++) {
		array[i] = (idNumber >> (8 * i)) & 0xff;
	}
	return array;
}

/**
 * Decode an actor ID from a 5-byte array.
 */
export function decodeActorId(array: Uint8Array): bigint {
	let id = 0n;
	for (let i = 0; i < 5; i++) {
		id = (id << 8n) | BigInt(array[i]);
	}
	return id;
}

/**
 * Find an update that matches a given actor event.
 */
export function matchActorEvent(event: Actor.Event) {
	return <T>(entry: Entry<T>) =>
		entry.actor === event.actor &&
		event.clock >= entry.clock &&
		event.clock <= entry.clock + BigInt(entry.content.length);
}
