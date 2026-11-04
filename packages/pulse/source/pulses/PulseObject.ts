import { CoreNode, managedFields } from "../core/model.js";
import { assertKey } from "../core/values.js";
import { pulsify } from "../utilities/pulsify.js";
import { PulseMetaSymbol } from "./PulseMeta.js";
import type { ProxyContext } from "./ProxyContext.js";
export type PulseObject<Value extends object> = Value;
export function assertProperty(key: PropertyKey): asserts key is string {
	assertKey(key);
}
const empty = Object.freeze({});
/** Shared traps avoid allocating a closure for every trap on every container. */
class ObjectHandler implements ProxyHandler<object> {
	constructor(
		private readonly node: () => CoreNode | undefined,
		private readonly context: ProxyContext,
		private readonly root: boolean,
	) {}
	private attached(): CoreNode | undefined {
		this.context.assertActive();
		const node = this.node();
		if (!this.root && (!node || !this.context.meta.model.isAttached(node)))
			throw new TypeError("This pulse object has been replaced or removed");
		return node;
	}
	private data(): Record<string, unknown> {
		return this.attached()?.data ?? empty;
	}
	get(_target: object, key: PropertyKey): unknown {
		if (key === PulseMetaSymbol && this.root) return this.context.meta;
		if (key === Symbol.toStringTag) return "PulseObject";
		const node = this.attached();
		if (typeof key !== "string" || !node || !Object.hasOwn(node.data, key))
			return Reflect.get(Object.prototype, key);
		const value: unknown = node.data[key];
		const child = node.child(key);
		return !child && (value === null || typeof value !== "object")
			? value
			: pulsify(value, child, this.context);
	}
	set(_target: object, key: PropertyKey, value: unknown): boolean {
		if (typeof key !== "string") assertKey(key);
		this.context.assertActive();
		const node = this.node();
		if (!node) throw new TypeError("Pulse is not loaded");
		this.context.meta.model.set(node, key as string, value);
		return true;
	}
	deleteProperty(_target: object, key: PropertyKey): boolean {
		if (typeof key !== "string") assertKey(key);
		this.context.assertActive();
		const node = this.node();
		if (!node) throw new TypeError("Pulse is not loaded");
		this.context.meta.model.delete(node, key as string);
		return true;
	}
	has(_target: object, key: PropertyKey): boolean {
		return (
			(key === PulseMetaSymbol && this.root) || Object.hasOwn(this.data(), key)
		);
	}
	ownKeys(): ArrayLike<string | symbol> {
		return Object.keys(this.data());
	}
	getOwnPropertyDescriptor(
		_target: object,
		key: PropertyKey,
	): PropertyDescriptor | undefined {
		if (typeof key === "symbol") return undefined;
		const node = this.attached();
		return node && Object.hasOwn(node.data, key)
			? {
					configurable: true,
					enumerable: true,
					writable: !(this.root && managedFields.has(String(key))),
					value: pulsify(
						node.data[String(key)],
						node.child(String(key)),
						this.context,
					),
				}
			: undefined;
	}
	defineProperty(): never {
		throw new TypeError("Pulse properties must be assigned or deleted");
	}
	setPrototypeOf(): boolean {
		return false;
	}
	preventExtensions(): boolean {
		return false;
	}
}
export function createObjectProxy(
	getNode: () => CoreNode | undefined,
	context: ProxyContext,
	root = false,
): object {
	return new Proxy({}, new ObjectHandler(getNode, context, root));
}
