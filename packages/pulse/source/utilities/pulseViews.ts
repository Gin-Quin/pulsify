import { RichTextSymbol, PulseRefSymbol } from "../core/values.js";
import { TreeSymbol } from "../core/treeSchema.js";
import type { Pulse } from "../pulses/Pulse.js";

const Raw = Symbol("Raw");

/**
 * Build the reactive wrapper of a framework whose reactivity follows reads
 * (signals): `tracker(pulse)` subscribes to one pulse and returns the function
 * to call on every read of it. The wrapper returns a view of the live pulse,
 * one per pulse: reads are tracked, at any depth, and writes go to the pulse.
 * A sub-pulse reached through a view is a view too, tracked on its own.
 */
export function createPulseViews(
	tracker: (pulse: Pulse<any>) => () => void,
): <P extends Pulse<any>>(pulse: P) => P {
	const roots = new WeakMap<object, object>();
	const wrap = <P extends Pulse<any>>(input: P): P => {
		const pulse: P = Reflect.get(input, Raw) ?? input;
		const existing = roots.get(pulse);
		if (existing) return existing as P;
		const track = tracker(pulse);
		const views = new WeakMap<object, object>();
		const view = (value: object): object => {
			const existing = views.get(value);
			if (existing) return existing;
			const proxy = new Proxy(value, {
				get(target, key) {
					if (key === Raw) return target === pulse ? pulse : undefined;
					if (key === "__v_skip") return true; // Vue must not wrap a view.
					track();
					return read(Reflect.get(target, key));
				},
			});
			views.set(value, proxy);
			return proxy;
		};
		// Keyed by the cached PulseRef, so lists keyed by identity keep their rows without leaking.
		const handles = new WeakMap<object, object>();
		const handle = (value: any): object => {
			const existing = handles.get(value);
			if (existing) return existing;
			const proxy = new Proxy(value, {
				get(target, key) {
					if (key === "pulse") {
						track();
						return target.pulse && wrap(target.pulse);
					}
					if (key === "load")
						return (options?: unknown) => target.load(options).then(wrap);
					return Reflect.get(target, key);
				},
			});
			handles.set(value, proxy);
			return proxy;
		};
		// ponytail: tree nodes and values returned by methods stay raw; view them if trees need fine tracking.
		const read = (value: any): unknown => {
			if (typeof value !== "object" || value === null) return value;
			if (value[PulseRefSymbol]) return handle(value);
			return Array.isArray(value) ||
				value[Symbol.toStringTag] === "PulseObject" ||
				value[RichTextSymbol] ||
				value[TreeSymbol]
				? view(value)
				: value;
		};
		const root = view(pulse);
		roots.set(pulse, root);
		return root as P;
	};
	return wrap;
}
