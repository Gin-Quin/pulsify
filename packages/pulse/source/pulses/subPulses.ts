import { connectPulse } from "../connection/connectPulse.js";
import type { Connector } from "../connection/Connector.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import type { CoreModel, CoreNode } from "../core/model.js";
import { ScalarPatch, type CorePatch } from "../core/operations.js";
import type { CompiledPulseSchema, PulseLayout } from "../core/schema.js";
import { PulseError } from "../protocol/errors.js";
import { isScopeDeleted } from "./deletion.js";
import { destroyPulse, type Pulse } from "./Pulse.js";
import type { AnyPulseDefinition } from "./PulseDefinition.js";
import { getPulseMeta, type PulseMeta } from "./PulseMeta.js";
import { subscribeScope } from "./scopeEvents.js";

const hasSubCache = new WeakMap<CompiledPulseSchema, boolean>();
const containsSubCache = new WeakMap<PulseLayout, boolean>();

/** Whether a compiled schema contains any `sub()` reference field. */
export function hasSubLayout(schema: CompiledPulseSchema | undefined): boolean {
	if (!schema) return false;
	const cached = hasSubCache.get(schema);
	if (cached !== undefined) return cached;
	const found = schema.layouts.some((layout) => layout.sub !== undefined);
	hasSubCache.set(schema, found);
	return found;
}

/** Whether `layout` is a `sub()` reference or can contain one at any depth. */
export function containsSub(layout: PulseLayout | undefined): boolean {
	if (!layout) return false;
	const cached = containsSubCache.get(layout);
	if (cached !== undefined) return cached;
	let found = false;
	const seen = new Set<PulseLayout>();
	const pending: PulseLayout[] = [layout];
	while (pending.length) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (current.sub !== undefined) {
			found = true;
			break;
		}
		if (current.value) pending.push(current.value);
		if (current.element) pending.push(current.element);
		for (const field of current.fields) pending.push(field.layout);
		if (current.elements) pending.push(...current.elements);
		if (current.variants) pending.push(...current.variants.values());
	}
	containsSubCache.set(layout, found);
	return found;
}

/** Resolve the child layout of property `key` on object/record/map `node`. */
export function fieldLayoutOf(
	node: CoreNode,
	key: string,
): PulseLayout | undefined {
	const layout = node.layout;
	if (!layout) return undefined;
	if (layout.kind === "object") return layout.fieldsByKey.get(key)?.layout;
	if (layout.kind === "record" || layout.kind === "map") return layout.element;
	return undefined;
}

/** Whether applying `patch` could add, replace, or remove any `sub()` reference. */
export function patchTouchesSub(model: CoreModel, patch: CorePatch): boolean {
	if (patch instanceof ScalarPatch) {
		const target = model.index.get(patch.target);
		if (!target) return true;
		if (typeof patch.field === "number") {
			const wf = target.wireLayout?.fields[patch.field];
			if (!wf) return false;
			return containsSub(
				target.layout?.fieldsByKey.get(wf.key)?.layout ?? wf.layout,
			);
		}
		if (target === model.root && patch.field === "version") return true;
		return containsSub(fieldLayoutOf(target, patch.field));
	}
	for (const op of patch.ops) {
		if (op.kind === 0 || op.kind === 10) return true;
		if (op.kind === 5 || op.kind === 6) continue;
		const target = model.index.get(op.target);
		if (!target) return true;
		if (op.kind === 1 || op.kind === 2) {
			if (typeof op.field === "number") {
				const wf = target.wireLayout?.fields[op.field];
				if (
					wf &&
					containsSub(
						target.layout?.fieldsByKey.get(wf.key)?.layout ?? wf.layout,
					)
				)
					return true;
			} else {
				if (target === model.root && op.field === "version") return true;
				if (containsSub(fieldLayoutOf(target, op.field))) return true;
			}
		} else if (target.kind !== "text" && containsSub(target.layout)) {
			return true;
		}
	}
	return false;
}

/** Collect all currently referenced sub-pulse IDs and their definitions. */
export function collectSubRefs(
	pulse: Pulse<any>,
): Map<string, AnyPulseDefinition> {
	const refs = new Map<string, AnyPulseDefinition>();
	const meta = getPulseMeta(pulse);
	const root = meta.definition.compiledSchema?.root;
	if (!root || !meta.loaded || !containsSub(root)) return refs;
	const visit = (layout: PulseLayout | undefined, value: unknown): void => {
		if (
			!layout ||
			value === undefined ||
			value === null ||
			!containsSub(layout)
		)
			return;
		if (layout.sub) {
			if (typeof value === "string" && !refs.has(value))
				refs.set(value, layout.sub);
			return;
		}
		switch (layout.kind) {
			case "optional":
				return visit(layout.value, value);
			case "object":
				for (const field of layout.fields)
					if (containsSub(field.layout))
						visit(field.layout, (value as Record<string, unknown>)[field.key]);
				return;
			case "array":
			case "tuple":
				if (Array.isArray(value))
					value.forEach((item, i) =>
						visit(
							layout.kind === "tuple" ? layout.elements?.[i] : layout.element,
							item,
						),
					);
				return;
			case "record":
			case "map":
				if (typeof value === "object")
					for (const item of Object.values(value)) visit(layout.element, item);
				return;
			case "union": {
				if (typeof value !== "object" || !layout.tagName) return;
				const tag = (value as Record<string, unknown>)[layout.tagName];
				return visit(layout.variants?.get(String(tag)), value);
			}
		}
	};
	visit(root, meta.model.view());
	return refs;
}

/** Consume any rows proactively pushed by connectors for `id`. */
export function consumePushedRows(
	connectors: readonly Connector[],
	id: string,
): PulsePatchRow[] | undefined {
	let merged: PulsePatchRow[] | undefined;
	for (const connector of connectors) {
		const rows = connector.takePushed?.(id);
		if (!rows?.length) continue;
		if (!merged) merged = [...rows];
		else merged.push(...rows);
	}
	return merged;
}

export type SubPulseTracker = {
	/** Enable automatic live loading of newly referenced sub-pulses. */
	enable(alreadyTried?: ReadonlySet<string>): void;
	/** Synchronize tracked references after a local or remote update. */
	sync(remote: boolean): void;
	dispose(): void;
};

export type SubPulseLoader = {
	createRuntime(
		definition: AnyPulseDefinition,
		id: string,
		options: PulseMeta["options"],
	): Pulse<any>;
	loadOne(
		definition: AnyPulseDefinition,
		id: string,
		input: Partial<PulseMeta["options"]>,
	): Promise<Pulse<any>>;
	loadSubPulses(
		pulse: Pulse<any>,
		input: Partial<PulseMeta["options"]>,
		visited: Set<string>,
	): Promise<void>;
};

let loader: SubPulseLoader | undefined;
export function registerSubPulseLoader(next: SubPulseLoader): void {
	loader = next;
}

/**
 * Tracks a pulse's `sub()` references for two concerns:
 * 1. Scope reactivity: whenever a referenced child transitions between
 *    `undefined` and loaded (or is deleted/destroyed), notify this pulse's
 *    listeners so views reading `ref.pulse` update.
 * 2. Live sub-pulse hydration (when `subPulses: true`): synchronously hydrate
 *    children whose initial rows were pushed by the server before parent
 *    listeners run, and fall back to async loading otherwise.
 */
export function createSubPulseTracker(
	meta: PulseMeta,
	notifyListeners: () => void,
): SubPulseTracker {
	const scopeStops = new Map<string, () => void>();
	const pushedStops: (() => void)[] = [];
	const tried = new Set<string>();
	const inFlight = new Set<string>();
	let currentRefs = new Map<string, AnyPulseDefinition>();
	let live = false;
	let syncing = false;
	let disposed = false;

	const isDeletedInScope = (id: string): boolean =>
		isScopeDeleted(meta.options.scope, id);

	const childOptions = () => ({ ...meta.options, connect: false });

	/**
	 * Synchronously hydrate a child from rows pushed by a connector.
	 * Returns true if the child is now loaded in the scope.
	 */
	const hydrateFromPushed = (
		id: string,
		definition: AnyPulseDefinition,
	): boolean => {
		if (!loader || isDeletedInScope(id)) return false;
		const scope = meta.options.scope;
		const existing = scope.pulses.get(id);
		if (existing) {
			const childMeta = getPulseMeta(existing);
			if (childMeta.definition !== definition) return false;
			if (childMeta.loaded) return true;
			const rows = consumePushedRows(meta.options.connectors, id);
			if (!rows?.length) return false;
			try {
				childMeta.applyRows(rows);
				if (childMeta.loaded) {
					childMeta.subPulses?.enable();
					return true;
				}
			} catch {
				// Leave ordinary connection loading to recover.
			}
			return false;
		}
		const rows = consumePushedRows(meta.options.connectors, id);
		if (!rows?.length) return false;
		const child = loader.createRuntime(definition, id, childOptions());
		const childMeta = getPulseMeta(child);
		try {
			childMeta.subPulses?.enable();
			childMeta.applyRows(rows);
			if (!childMeta.loaded) {
				destroyPulse(child);
				return false;
			}
			// Connect in the background to subscribe and persist to local stores.
			void connectPulse(child).synced.catch(() => {});
			return true;
		} catch {
			destroyPulse(child);
			return false;
		}
	};

	const loadAsync = (id: string, definition: AnyPulseDefinition): void => {
		if (!loader || disposed || inFlight.has(id) || isDeletedInScope(id)) return;
		const existing = meta.options.scope.pulses.get(id);
		if (existing && getPulseMeta(existing).loaded) return;
		inFlight.add(id);
		const options = childOptions();
		void loader
			.loadOne(definition, id, options)
			.then(async (loaded) => {
				if (disposed || meta.destroyed || meta.deleted) return;
				const visited = new Set<string>([meta.id]);
				await loader!.loadSubPulses(loaded, options, visited);
				getPulseMeta(loaded).subPulses?.enable(visited);
			})
			.catch((error) => {
				if (!(error instanceof PulseError && error.code === "NOT_FOUND"))
					meta.report(
						error instanceof Error ? error : new Error(String(error)),
					);
			})
			.finally(() => {
				inFlight.delete(id);
			});
	};

	const watchPushed = () => {
		if (pushedStops.length || !meta.options.subPulses) return;
		for (const connector of meta.options.connectors) {
			if (!connector.onPushed) continue;
			pushedStops.push(
				connector.onPushed((docId) => {
					if (disposed || !live || meta.destroyed || meta.deleted) return;
					const definition = currentRefs.get(docId);
					if (!definition) return;
					const existing = meta.options.scope.pulses.get(docId);
					if (existing && getPulseMeta(existing).loaded) return;
					hydrateFromPushed(docId, definition);
				}),
			);
		}
	};

	const updateScopeWatchers = (refs: Map<string, AnyPulseDefinition>) => {
		for (const [id, stop] of scopeStops) {
			if (!refs.has(id)) {
				stop();
				scopeStops.delete(id);
				tried.delete(id);
			}
		}
		for (const id of refs.keys()) {
			if (scopeStops.has(id)) continue;
			scopeStops.set(
				id,
				subscribeScope(meta.options.scope, id, () => {
					if (!disposed && !syncing && !meta.destroyed) notifyListeners();
				}),
			);
		}
	};

	return {
		enable(alreadyTried) {
			if (disposed || !meta.options.subPulses) return;
			if (alreadyTried) for (const id of alreadyTried) tried.add(id);
			if (live) return;
			live = true;
			watchPushed();
			if (meta.loaded) this.sync(true);
		},
		sync(remote) {
			if (disposed || meta.destroyed || meta.deleted || !meta.loaded) return;
			const refs = collectSubRefs(meta.pulse);
			currentRefs = refs;
			syncing = true;
			try {
				if (
					remote &&
					live &&
					meta.options.subPulses &&
					meta.options.connectors.length &&
					meta.connections.some((connection) => connection.active)
				) {
					for (const [id, definition] of refs) {
						if (tried.has(id) || isDeletedInScope(id)) continue;
						const existing = meta.options.scope.pulses.get(id);
						if (existing && getPulseMeta(existing).loaded) {
							tried.add(id);
							continue;
						}
						tried.add(id);
						if (!hydrateFromPushed(id, definition)) loadAsync(id, definition);
					}
				}
				updateScopeWatchers(refs);
			} finally {
				syncing = false;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const stop of scopeStops.values()) stop();
			scopeStops.clear();
			for (const stop of pushedStops.splice(0)) stop();
			tried.clear();
			inFlight.clear();
			currentRefs.clear();
		},
	};
}
