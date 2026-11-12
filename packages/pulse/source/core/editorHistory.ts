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
		lastTyping = "",
		capturing = false,
		replaying = false;
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	const stop = () => {
		capturing = false;
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
				for (const group of [...undo, ...redo]) {
					group.inserted = group.inserted.map((id) => identities.get(id) ?? id);
					group.deleted = group.deleted.map((id) => identities.get(id) ?? id);
					for (const attribute of group.attributes) {
						const oldEntry = attribute.entry;
						attribute.entry = identities.get(oldEntry) ?? oldEntry;
						const mark = context.node.entries
							.get(attribute.entry)
							?.marks.get(attribute.key);
						if (identities.has(oldEntry)) {
							const old = context.node.entries
								.get(oldEntry)
								?.marks.get(attribute.key);
							if (mark && sameStamp(attribute.stamp, old?.stamp))
								attribute.stamp = mark.stamp;
						} else {
							const update = change.attributes.find(
								(item) => item.entry === oldEntry && item.key === attribute.key,
							);
							const applied = inverse.attributes.find(
								(item) => item.entry === oldEntry && item.key === attribute.key,
							);
							if (applied && sameStamp(attribute.stamp, update?.beforeStamp))
								attribute.stamp = applied.stamp;
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
					const ids = [...change.inserted, ...change.deleted],
						entry =
							ids.length === 1 ? context.node.entries.get(ids[0]!) : undefined;
					const typing =
						entry && !entry.marks.has(RT_NODE) && !change.attributes.length
							? `${change.inserted.length ? "insert" : "delete"}:${entry.marks.get(RT_PARENT)?.value}`
							: "";
					const now = Date.now();
					const adjacent =
						entry &&
						(change.inserted.length
							? entry.after === lastEntry
							: Math.abs(
									context.node.order.findIndex((item) => item.id === entry.id) -
										context.node.order.findIndex(
											(item) => item.id === lastEntry,
										),
								) === 1);
					if (
						undo.length &&
						capturing &&
						!options.push &&
						(options.merge ||
							(typing &&
								typing === lastTyping &&
								adjacent &&
								now - lastTime < delay))
					)
						undo[undo.length - 1] = mergeChanges(undo.at(-1)!, change);
					else undo.push(change);
					while (undo.length > limit) undo.shift();
					redo.length = 0;
					lastTime = now;
					lastEntry = entry?.id ?? "";
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
