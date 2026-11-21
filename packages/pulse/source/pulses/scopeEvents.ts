import type { PulseScope } from "./PulseOptions.js";

const listenersByScope = new WeakMap<
	PulseScope,
	Map<string, Set<() => void>>
>();

/**
 * Subscribe to availability transitions (loaded / deleted / destroyed) of a
 * pulse ID within a scope. Used so `ref.pulse` transitions notify observers.
 */
export function subscribeScope(
	scope: PulseScope,
	id: string,
	listener: () => void,
): () => void {
	let byId = listenersByScope.get(scope);
	if (!byId) {
		byId = new Map();
		listenersByScope.set(scope, byId);
	}
	let set = byId.get(id);
	if (!set) {
		set = new Set();
		byId.set(id, set);
	}
	set.add(listener);
	return () => {
		set.delete(listener);
		if (!set.size) byId.delete(id);
	};
}

export function notifyScope(scope: PulseScope, id: string): void {
	const set = listenersByScope.get(scope)?.get(id);
	if (!set?.size) return;
	for (const listener of [...set]) {
		try {
			listener();
		} catch {
			// A failing listener must not break other observers.
		}
	}
}
