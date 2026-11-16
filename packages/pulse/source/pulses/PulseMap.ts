import type { CoreNode } from "../core/model.js";
import { mapEntries, type MapKey } from "../core/mapKey.js";
import { pulsify } from "../utilities/pulsify.js";
import type { ProxyContext } from "./ProxyContext.js";

/**
 * The collaborative view of a `map(key, value)`. It is a `Map`, so
 * `instanceof Map` holds and it goes wherever a `Map` is expected, but every
 * method reads and writes the pulse: its own Map storage stays empty.
 *
 * Entries iterate in ascending key order, not insertion order: peers receive
 * entries in different orders, and a sorted map reads the same on all of them.
 */
class PulseMap extends Map<unknown, unknown> {
	// Fields, not constructor parameters: Map's constructor takes the entries.
	private node!: CoreNode;
	private context!: ProxyContext;
	static of(node: CoreNode, context: ProxyContext): PulseMap {
		const map = new PulseMap();
		map.node = node;
		map.context = context;
		return map;
	}
	private get key(): MapKey {
		return this.node.layout!.key!;
	}
	private data(): Record<string, unknown> {
		this.context.assertActive();
		if (!this.context.meta.model.isAttached(this.node))
			throw new TypeError("This pulse map has been replaced or removed");
		return this.node.data;
	}
	/** The stored key, or undefined for a key of another type: it is not there. */
	private find(key: unknown): string | undefined {
		const data = this.data();
		try {
			const text = this.key.encode(key);
			return Object.hasOwn(data, text) ? text : undefined;
		} catch {
			return undefined;
		}
	}
	private at(text: string): unknown {
		return pulsify(
			this.node.data[text],
			this.node.child(text),
			this.context,
			this.node.layout!.element,
		);
	}
	override get size(): number {
		return Object.keys(this.data()).length;
	}
	override has(key: unknown): boolean {
		return this.find(key) !== undefined;
	}
	override get(key: unknown): unknown {
		const text = this.find(key);
		return text === undefined ? undefined : this.at(text);
	}
	override set(key: unknown, value: unknown): this {
		this.context.assertActive();
		this.context.meta.model.set(this.node, this.key.encode(key), value);
		return this;
	}
	override delete(key: unknown): boolean {
		const text = this.find(key);
		if (text === undefined) return false;
		this.context.meta.model.delete(this.node, text);
		return true;
	}
	override clear(): void {
		// ponytail: one patch per key; batch them in the model if clearing large
		// maps ever shows up in a profile.
		for (const text of Object.keys(this.data()))
			this.context.meta.model.delete(this.node, text);
	}
	private sorted(): [unknown, unknown][] {
		return mapEntries(this.key, this.data()).map(([key, text]) => [
			key,
			this.at(text),
		]);
	}
	override entries(): MapIterator<[unknown, unknown]> {
		return this.sorted().values();
	}
	override keys(): MapIterator<unknown> {
		return this.sorted()
			.map((entry) => entry[0])
			.values();
	}
	override values(): MapIterator<unknown> {
		return this.sorted()
			.map((entry) => entry[1])
			.values();
	}
	override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
		return this.entries();
	}
	override forEach(
		callback: (
			value: unknown,
			key: unknown,
			map: Map<unknown, unknown>,
		) => void,
		thisArg?: unknown,
	): void {
		for (const [key, value] of this.sorted())
			callback.call(thisArg, value, key, this);
	}
	/** JSON has no Map: entries keep their key type and feed `new Map(json)`. */
	toJSON(): [unknown, unknown][] {
		return this.sorted();
	}
}

export function createMapProxy(
	node: CoreNode,
	context: ProxyContext,
): Map<unknown, unknown> {
	return PulseMap.of(node, context);
}
