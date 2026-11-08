import { PulseError } from "../protocol/errors.js";
import { RichTextSymbol } from "../core/values.js";
import type { RichText } from "../core/richText.js";
import type { Tree } from "../core/tree.js";
import { TreeSymbol, type TreeData } from "../core/treeSchema.js";
import type { PulseLayout } from "../core/schema.js";
import type { Pulsify } from "../utilities/pulsify.js";
import { type PulseMeta, PulseMetaSymbol } from "./PulseMeta.js";
import { defaultPulseScope } from "./PulseOptions.js";
import type { PulseProperties } from "./PulseProperties.js";
import type { Tuple } from "../utilities/Tuple.js";

export const pulses = defaultPulseScope.pulses;
export type Pulse<
	Properties extends PulseProperties<string> = PulseProperties<string>,
> = { [Key in keyof Properties]: Pulsify<Properties[Key]> } & {
	readonly id: Properties["id"];
	readonly kind: Properties["kind"];
	readonly version: number;
	readonly [PulseMetaSymbol]: PulseMeta;
};

export function disconnectPulse(pulse: Pulse<any>): void {
	const meta = pulse[PulseMetaSymbol];
	meta.cancelConnection?.(new PulseError("CLOSED", "Pulse disconnected"));
	for (const connection of meta.connections) connection.close();
	meta.connecting = undefined;
	meta.status = "idle";
}
export function destroyPulse(pulse: Pulse<any>): void {
	const meta = pulse[PulseMetaSymbol];
	if (meta.destroyed) return;
	meta.destroyed = true;
	disconnectPulse(pulse);
	for (const connection of meta.connections) connection.dispose();
	meta.listeners.clear();
	meta.rowListeners.clear();
	meta.options.scope.pulses.delete(meta.id);
}
/** Subscribe synchronously to local and remote changes; first call is immediate. */
export function subscribePulse<P extends Pulse<any>>(
	pulse: P,
	listener: (pulse: P) => void,
): () => void {
	const meta = pulse[PulseMetaSymbol];
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	const wrapped = () => listener(pulse);
	meta.listeners.add(wrapped);
	try {
		wrapped();
	} catch (error) {
		meta.listeners.delete(wrapped);
		throw error;
	}
	return () => meta.listeners.delete(wrapped);
}
type SnapshotTuple<Values extends readonly unknown[]> = {
	-readonly [Key in keyof Values]: PulseSnapshot<Values[Key]>;
};

/** A detached snapshot of the public, materialized model. */
export type PulseSnapshot<Value> = unknown extends Value
	? Value
	: Value extends RichText
		? string
		: Value extends Tree<infer Item>
			? TreeData<PulseSnapshot<Item>>
			: Value extends Uint8Array
				? Uint8Array
				: Value extends Tuple<infer Elements>
					? SnapshotTuple<Elements>
					: Value extends readonly (infer Item)[]
						? number extends Value["length"]
							? PulseSnapshot<Item>[]
							: SnapshotTuple<Value>
						: Value extends object
							? {
									[Key in keyof Value as Key extends string | number
										? Key
										: never]: PulseSnapshot<Value[Key]>;
								}
							: Value;
const snapshotFieldCounts = new WeakMap<PulseLayout, number>();
function snapshotFieldCount(layout: PulseLayout): number {
	let count = snapshotFieldCounts.get(layout);
	if (count === undefined) {
		count = layout.fields.length;
		for (const key of ["id", "kind", "version", "generation"])
			if (!layout.fieldsByKey.has(key)) count++;
		snapshotFieldCounts.set(layout, count);
	}
	return count;
}
export function snapshotPulse<P extends Pulse<any>>(
	pulse: P,
): PulseSnapshot<P> {
	const meta = pulse[PulseMetaSymbol];
	if (!meta.definition.materializer) {
		const data = meta.loaded ? meta.model.view() : {};
		const compiled = meta.definition.compiledSchema;
		const layout = meta.model.root?.layout;
		if (
			compiled &&
			layout?.kind === "object" &&
			compiled.layouts[layout.id] === layout &&
			data.version === meta.definition.migrations.length + 1 &&
			Object.keys(data).length === snapshotFieldCount(layout)
		) {
			return layout.snapshot(data, true) as PulseSnapshot<P>;
		}
		return structuredClone(data) as PulseSnapshot<P>;
	}
	const clone = (value: any): any => {
		if (value && typeof value === "object" && value[TreeSymbol])
			return value.snapshot();
		if (value && typeof value === "object" && value[RichTextSymbol])
			return value.toString();
		if (value instanceof Uint8Array) return new Uint8Array(value);
		return value && typeof value === "object"
			? Array.isArray(value)
				? Array.from(value, clone)
				: Object.fromEntries(
						Object.entries(value).map(([key, item]) => [key, clone(item)]),
					)
			: value;
	};
	return clone(pulse);
}
