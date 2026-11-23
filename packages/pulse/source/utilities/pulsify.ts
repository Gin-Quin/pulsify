import { constantView } from "../core/values.js";
import type { CoreModel, CoreNode } from "../core/model.js";
import { ScalarPatch, type CorePatch } from "../core/operations.js";
import { createTextProxy, type RichText } from "../core/richText.js";
import { createPlainTextProxy, type PlainText } from "../core/plainText.js";
import { createCounterProxy, type Counter } from "../core/counter.js";
import { createTreeProxy, type Tree } from "../core/tree.js";
import {
	createArrayProxy,
	type PulseArray,
	type PulseTuple,
} from "../pulses/PulseArray.js";
import { createObjectProxy } from "../pulses/PulseObject.js";
import { createMapProxy } from "../pulses/PulseMap.js";
import {
	directNodeRevision,
	registerNodeProxy,
} from "../pulses/nodeRevisions.js";
import type { ProxyContext } from "../pulses/ProxyContext.js";
import type { IsSameType } from "./IsSameType.js";
import type { PulseLayout } from "../core/schema.js";
import { createPulseRef, type PulseRef } from "../pulses/PulseRef.js";

const nodeRefs = new WeakMap<CoreNode, Map<string, PulseRef>>();
const entryRefs = new WeakMap<object, PulseRef>();

/** Drop a cached `PulseRef` when its object/map slot is deleted or overwritten. */
export function invalidateCachedRef(
	node: CoreNode,
	key: string,
	nextValue?: unknown,
): void {
	const refs = nodeRefs.get(node);
	if (!refs) return;
	const cached = refs.get(key);
	if (cached && cached.id !== nextValue) refs.delete(key);
}

/** Drop cached `PulseRef`s invalidated by a committed or remote patch. */
export function invalidatePatchRefs(model: CoreModel, patch: CorePatch): void {
	if (patch instanceof ScalarPatch) {
		const target = model.index.get(patch.target);
		if (!target || !nodeRefs.has(target)) return;
		const key =
			typeof patch.field === "number"
				? target.wireLayout?.fields[patch.field]?.key
				: patch.field;
		if (key !== undefined) invalidateCachedRef(target, key, patch.value);
		return;
	}
	for (const op of patch.ops) {
		if (op.kind !== 1 && op.kind !== 2) continue;
		const target = model.index.get(op.target);
		if (!target || !nodeRefs.has(target)) continue;
		const key =
			typeof op.field === "number"
				? target.wireLayout?.fields[op.field]?.key
				: op.field;
		if (key !== undefined)
			invalidateCachedRef(
				target,
				key,
				op.kind === 1 ? op.value.value : undefined,
			);
	}
}

type PulseBytes<Value extends Uint8Array> =
	IsSameType<Value, Readonly<Value>> extends true
		? Readonly<Uint8Array>
		: Uint8Array;

export type Pulsify<Value> = Value extends PulseRef<any> | Counter
	? Value
	: Value extends PlainText
		? PlainText
		: Value extends RichText
			? RichText
			: Value extends Tree<infer Item>
				? Tree<Item>
				: Value extends Uint8Array
					? PulseBytes<Value>
					: Value extends Array<infer Item>
						? number extends Value["length"]
							? PulseArray<Pulsify<Item>>
							: PulseTuple<Value>
						: Value extends Map<infer Key, infer Item>
							? Map<Key, Pulsify<Item>>
							: Value extends object
								? { [Key in keyof Value]: Pulsify<Value[Key]> }
								: Value;

export function pulsify(
	value: unknown,
	node: CoreNode | undefined,
	context: ProxyContext,
	layout?: PulseLayout,
	owner?: CoreNode | object,
	slot?: string,
): any {
	if (!node) {
		if (layout?.sub && typeof value === "string") {
			if (owner && slot !== undefined) {
				const parent = owner as CoreNode;
				let refs = nodeRefs.get(parent);
				const cached = refs?.get(slot);
				if (cached && cached.id === value && cached.definition === layout.sub)
					return cached;
				if (!refs) nodeRefs.set(parent, (refs = new Map()));
				const ref = createPulseRef(layout.sub, value, context.meta.options);
				refs.set(slot, ref);
				return ref;
			}
			if (owner) {
				const cached = entryRefs.get(owner);
				if (cached && cached.id === value && cached.definition === layout.sub)
					return cached;
				const ref = createPulseRef(layout.sub, value, context.meta.options);
				entryRefs.set(owner, ref);
				return ref;
			}
			return createPulseRef(layout.sub, value, context.meta.options);
		}
		return value instanceof Uint8Array
			? new Uint8Array(value)
			: constantView(value);
	}
	if (node.proxy) return node.proxy;
	if (node.layout?.tree) node.proxy = createTreeProxy(node, context);
	else if (node.kind === "text") {
		const binding = {
			subscribe(listener: () => void) {
				let last = directNodeRevision(node);
				const wrapped = () => {
					const current = directNodeRevision(node);
					if (current === last && context.meta.model.isAttached(node)) return;
					last = current;
					listener();
				};
				context.meta.listeners.add(wrapped);
				return () => {
					context.meta.listeners.delete(wrapped);
				};
			},
			get pulse() {
				return context.meta.pulse;
			},
		};
		node.proxy = (
			node.layout?.plainText ? createPlainTextProxy : createTextProxy
		)(node, context.meta.model, context.assertActive, binding);
	} else if (node.kind === "array")
		node.proxy = createArrayProxy(node, context);
	else if (node.layout?.counter)
		node.proxy = createCounterProxy(
			node,
			context.meta.model,
			context.assertActive,
		);
	else if (node.layout?.kind === "map")
		node.proxy = createMapProxy(node, context);
	else node.proxy = createObjectProxy(() => node, context);
	registerNodeProxy(node.proxy as object, node);
	return node.proxy;
}
