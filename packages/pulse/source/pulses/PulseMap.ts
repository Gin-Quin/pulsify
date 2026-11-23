import type { CoreNode } from "../core/model.js";
import { mapEntries, type MapKey } from "../core/mapKey.js";
import { pulsify } from "../utilities/pulsify.js";
import { directNodeRevision } from "./nodeRevisions.js";
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
	private cachedCount: number | undefined;
	private countRevision = -1;
	private cachedKeys: [unknown, string][] | undefined;
	private cachedOnlyKeys: unknown[] | undefined;
	private keysRevision = -1;
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
			this.node,
			text,
		);
	}
	private sortedKeys(): [unknown, string][] {
		const data = this.data();
		const rev = directNodeRevision(this.node);
		if (this.cachedKeys && this.keysRevision === rev) return this.cachedKeys;
		const entries = mapEntries(this.key, data);
		this.cachedKeys = entries;
		this.cachedOnlyKeys = undefined;
		this.keysRevision = rev;
		this.cachedCount = entries.length;
		this.countRevision = rev;
		return entries;
	}
	override get size(): number {
		const data = this.data();
		const rev = directNodeRevision(this.node);
		if (this.cachedCount !== undefined && this.countRevision === rev)
			return this.cachedCount;
		const count = Object.keys(data).length;
		this.cachedCount = count;
		this.countRevision = rev;
		return count;
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
		const text = this.key.encode(key);
		const existed = Object.hasOwn(this.node.data, text);
		const revBefore = directNodeRevision(this.node);
		this.context.meta.model.set(this.node, text, value);
		const revAfter = directNodeRevision(this.node);
		if (revAfter === revBefore + 1) {
			if (this.cachedCount !== undefined && this.countRevision === revBefore) {
				if (!existed) this.cachedCount++;
				this.countRevision = revAfter;
			}
			if (existed && this.cachedKeys && this.keysRevision === revBefore)
				this.keysRevision = revAfter;
		}
		return this;
	}
	override delete(key: unknown): boolean {
		const text = this.find(key);
		if (text === undefined) return false;
		const revBefore = directNodeRevision(this.node);
		this.context.meta.model.delete(this.node, text);
		const revAfter = directNodeRevision(this.node);
		if (
			revAfter === revBefore + 1 &&
			this.cachedCount !== undefined &&
			this.countRevision === revBefore
		) {
			this.cachedCount--;
			this.countRevision = revAfter;
		}
		return true;
	}
	override clear(): void {
		// ponytail: one patch per key; batch them in the model if clearing large
		// maps ever shows up in a profile.
		for (const text of Object.keys(this.data()))
			this.context.meta.model.delete(this.node, text);
	}
	override *entries(): MapIterator<[unknown, unknown]> {
		for (const [key, text] of this.sortedKeys()) yield [key, this.at(text)];
	}
	override keys(): MapIterator<unknown> {
		const entries = this.sortedKeys();
		return (this.cachedOnlyKeys ??= entries.map(([key]) => key)).values();
	}
	override *values(): MapIterator<unknown> {
		for (const [, text] of this.sortedKeys()) yield this.at(text);
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
		for (const [key, text] of this.sortedKeys())
			callback.call(thisArg, this.at(text), key, this);
	}
	/** JSON has no Map: entries keep their key type and feed `new Map(json)`. */
	toJSON(): [unknown, unknown][] {
		return this.sortedKeys().map(([key, text]) => [key, this.at(text)]);
	}
}

export function createMapProxy(
	node: CoreNode,
	context: ProxyContext,
): Map<unknown, unknown> {
	return PulseMap.of(node, context);
}
