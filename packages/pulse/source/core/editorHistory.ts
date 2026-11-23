import { invertEditorChange, type EditorChange } from "./editorTokens.js";
import { RT_NODE, RT_PARENT, type RichTextContext } from "./richTextBinding.js";
import type { Stamp } from "./model.js";

export interface PulsifyHistoryOptions {
	/** Group adjacent typing within this interval in milliseconds. Default: 300. */
	undoDelay?: number;
	/** Maximum undo groups retained. Zero disables capture. Default: 100. */
	maxUndo?: number;
}
/** A local history plugin, connected by either editor binding. Stacks are not persisted. */
export interface PulsifyHistory {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	undo(): boolean;
	redo(): boolean;
	clear(): void;
	/** Make the next edit start a new group. */
	stopCapturing(): void;
	/** Observe capture, undo, redo and clear. Unsubscribe with the returned function. */
	subscribe(listener: () => void): () => void;
}
type HistoryConnection = {
	record(
		change: EditorChange,
		options?: { push?: boolean; merge?: boolean; capture?: boolean },
	): void;
	destroy(): void;
};
type HistoryState = {
	connect(context: RichTextContext, hooks: HistoryHooks): HistoryConnection;
};
type HistoryHooks = {
	/** Flush pending editor updates before checking stack availability. */
	flush(): void;
	/** Suppress the binding's write loop, then render the resulting field. */
	replay(action: () => void): void;
};
const histories = new WeakMap<PulsifyHistory, HistoryState>();
const sameStamp = (a: Stamp | undefined, b: Stamp | undefined) =>
	!!a && !!b && a.every((part, index) => part === b[index]);
const changed = (change: EditorChange) =>
	!!(
		change.inserted.length ||
		change.deleted.length ||
		change.attributes.length
	);

/** Create one plugin per bound editor. Re-exported by both editor packages. */
export function createPulsifyHistory(
	options: PulsifyHistoryOptions = {},
): PulsifyHistory {
	const delay = options.undoDelay ?? 300,
		limit = options.maxUndo ?? 100;
	if (
		!Number.isFinite(delay) ||
		delay < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 0
	)
		throw new TypeError("Invalid Pulsify history options");
	const undo: EditorChange[] = [],
		redo: EditorChange[] = [],
		listeners = new Set<() => void>();
	let connection: { context: RichTextContext; hooks: HistoryHooks } | undefined;
	let lastTime = 0,
		lastEntry = "",
		lastOrderIndex = -1,
		lastTyping = "",
		capturing = false,
		replaying = false;
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	const stop = () => {
		capturing = false;
		lastOrderIndex = -1;
	};
	const replay = (from: EditorChange[], to: EditorChange[]): boolean => {
		if (!connection || replaying) return false;
		connection.hooks.flush();
		if (!connection || !from.length) return false;
		const { context, hooks } = connection,
			change = from.at(-1)!;
		context.assertActive();
		// Restored characters get fresh identities; older groups must follow them.
		const restored = change.deleted.filter(
			(id) => context.node.entries.get(id)?.deleted,
		);
		let inverse: EditorChange;
		replaying = true;
		try {
			hooks.replay(() => {
				inverse = invertEditorChange(context, change);
				from.pop();
				const identities = new Map(
					restored.map((id, index) => [id, inverse.inserted[index]!]),
				);
				const hasIdentities = identities.size > 0;
				let changeAttrs:
					Map<string, EditorChange["attributes"][number]> | undefined;
				let appliedAttrs:
					Map<string, EditorChange["attributes"][number]> | undefined;
				if (inverse.attributes.length) {
					changeAttrs = new Map();
					for (const item of change.attributes) {
						const key = `${item.entry}|${item.key}`;
						if (!changeAttrs.has(key)) changeAttrs.set(key, item);
					}
					appliedAttrs = new Map();
					for (const item of inverse.attributes) {
						const key = `${item.entry}|${item.key}`;
						if (!appliedAttrs.has(key)) appliedAttrs.set(key, item);
					}
				}
				if (hasIdentities || appliedAttrs) {
					for (const stack of [undo, redo])
						for (const group of stack) {
							if (hasIdentities) {
								if (group.inserted.length)
									group.inserted = group.inserted.map(
										(id) => identities.get(id) ?? id,
									);
								if (group.deleted.length)
									group.deleted = group.deleted.map(
										(id) => identities.get(id) ?? id,
									);
							}
							for (const attribute of group.attributes) {
								const oldEntry = attribute.entry;
								const mapped = hasIdentities
									? identities.get(oldEntry)
									: undefined;
								if (mapped !== undefined) {
									attribute.entry = mapped;
									const mark = context.node.entries
										.get(mapped)
										?.marks.get(attribute.key);
									const old = context.node.entries
										.get(oldEntry)
										?.marks.get(attribute.key);
									if (mark && sameStamp(attribute.stamp, old?.stamp))
										attribute.stamp = mark.stamp;
								} else if (appliedAttrs) {
									const attrKey = `${oldEntry}|${attribute.key}`;
									const applied = appliedAttrs.get(attrKey);
									if (applied) {
										const update = changeAttrs!.get(attrKey);
										if (sameStamp(attribute.stamp, update?.beforeStamp))
											attribute.stamp = applied.stamp;
									}
								}
							}
						}
				}
				to.push(inverse);
				stop();
			});
		} finally {
			replaying = false;
		}
		notify();
		return true;
	};
	const history: PulsifyHistory = {
		get canUndo() {
			return undo.length > 0;
		},
		get canRedo() {
			return redo.length > 0;
		},
		undo: () => replay(undo, redo),
		redo: () => replay(redo, undo),
		clear() {
			undo.length = redo.length = 0;
			stop();
			notify();
		},
		stopCapturing: stop,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	histories.set(history, {
		connect(context, hooks) {
			if (connection)
				throw new TypeError(
					"This Pulsify history is already connected to an editor",
				);
			const own = (connection = { context, hooks });
			return {
				record(change, options = {}) {
					if (connection !== own || replaying || !changed(change)) return;
					if (options.capture === false) {
						redo.length = 0;
						stop();
						notify();
						return;
					}
					const singleId =
						change.inserted.length + change.deleted.length === 1
							? (change.inserted[0] ?? change.deleted[0])
							: undefined;
					const entry = singleId
						? context.node.entries.get(singleId)
						: undefined;
					const typing =
						entry && !entry.marks.has(RT_NODE) && !change.attributes.length
							? `${change.inserted.length ? "insert" : "delete"}:${entry.marks.get(RT_PARENT)?.value}`
							: "";
					const now = Date.now();
					let nextOrderIndex = -1;
					let mergeTyping = false;
					if (
						undo.length &&
						capturing &&
						!options.push &&
						!options.merge &&
						typing &&
						typing === lastTyping &&
						now - lastTime < delay &&
						entry
					) {
						if (change.inserted.length) {
							mergeTyping = entry.after === lastEntry;
						} else {
							const last = lastEntry
								? context.node.entries.get(lastEntry)
								: undefined;
							if (last && last !== entry) {
								const order = context.node.order;
								if (lastOrderIndex >= 0 && order[lastOrderIndex] === last) {
									if (
										lastOrderIndex > 0 &&
										order[lastOrderIndex - 1] === entry
									) {
										mergeTyping = true;
										nextOrderIndex = lastOrderIndex - 1;
									} else if (
										lastOrderIndex + 1 < order.length &&
										order[lastOrderIndex + 1] === entry
									) {
										mergeTyping = true;
										nextOrderIndex = lastOrderIndex + 1;
									}
								} else if (
									entry.children[0] === last ||
									last.children[0] === entry
								) {
									mergeTyping = true;
								} else if (entry.children.length && last.children.length) {
									mergeTyping = false;
								} else {
									const entryIndex = order.indexOf(entry);
									const lastIndex = order.indexOf(last);
									nextOrderIndex = entryIndex;
									mergeTyping =
										entryIndex >= 0 &&
										lastIndex >= 0 &&
										Math.abs(entryIndex - lastIndex) === 1;
								}
							}
						}
					}
					if (
						undo.length &&
						capturing &&
						!options.push &&
						(options.merge || mergeTyping)
					)
						undo[undo.length - 1] = mergeChanges(undo.at(-1)!, change);
					else undo.push(change);
					while (undo.length > limit) undo.shift();
					redo.length = 0;
					lastTime = now;
					lastEntry = entry?.id ?? "";
					lastOrderIndex = nextOrderIndex;
					lastTyping = typing;
					capturing = true;
					notify();
				},
				destroy() {
					if (connection !== own) return;
					connection = undefined;
					history.clear();
				},
			};
		},
	});
	return history;
}
/** Adapter API: connect the editor-independent plugin to a field's operations. */
export function connectEditorHistory(
	history: PulsifyHistory,
	context: RichTextContext,
	hooks: HistoryHooks,
): HistoryConnection {
	const state = histories.get(history);
	if (!state)
		throw new TypeError(
			"Use createPulsifyHistory() to create a history plugin",
		);
	return state.connect(context, hooks);
}
function mergeChanges(before: EditorChange, after: EditorChange): EditorChange {
	const inserted = new Set(before.inserted),
		deleted = new Set(before.deleted);
	for (const id of after.inserted) inserted.add(id);
	for (const id of after.deleted) {
		if (!inserted.delete(id)) deleted.add(id);
	}
	const attributes = new Map(
		before.attributes.map((item) => [
			JSON.stringify([item.entry, item.key]),
			item,
		]),
	);
	for (const item of after.attributes) {
		const key = JSON.stringify([item.entry, item.key]),
			previous = attributes.get(key);
		attributes.set(
			key,
			previous
				? {
						...item,
						before: previous.before,
						beforeStamp: previous.beforeStamp,
					}
				: item,
		);
	}
	return {
		inserted: [...inserted],
		deleted: [...deleted],
		attributes: [...attributes.values()].filter(
			(item) => !inserted.has(item.entry),
		),
	};
}
