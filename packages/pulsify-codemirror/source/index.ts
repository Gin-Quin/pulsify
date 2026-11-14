import {
	Annotation,
	Compartment,
	StateEffect,
	Transaction,
	type Extension,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";
import {
	joinPresence,
	RichTextSelection,
	type PlainText,
	type Presence,
	type Pulse,
} from "pulsify-core";
import { heldSelections, plainTextContext } from "pulsify-core/bindings";

export interface CodeMirrorBindingOptions {
	/**
	 * Share my selection through presence and draw the caret and selected range of
	 * every other peer in this field. `true` shares without a name.
	 * `draw: false` shares mine and draws nothing. Mine is shared while the
	 * editor has the focus. A peer without a color gets one from its peer number.
	 */
	selection?: boolean | { name?: string; color?: string; draw?: boolean };
}
export interface CodeMirrorBinding {
	/** Detach the editor from the field; the editor keeps its document. */
	destroy(): void;
}

/** The state of the `RichTextSelection` channel. */
type SharedSelection = {
	anchor: string;
	head: string;
	name: string;
	color: string;
};

const remote = Annotation.define<boolean>();
const redrawEffect = StateEffect.define<null>();
/** The binding that last shared a selection on each pulse, by its token. */
const publishers = new WeakMap<object, object>();

/**
 * Bind an existing CodeMirror view to a `plainText()` field. The field
 * supplies the document; editor changes edit the field, and changes from
 * other peers reach the editor outside its undo history.
 */
export function bindCodeMirror(
	view: EditorView,
	field: PlainText,
	options: CodeMirrorBindingOptions = {},
): CodeMirrorBinding {
	const { subscribe, pulse } = plainTextContext(field);
	const sharing =
		options.selection === true ? {} : options.selection || undefined;
	for (const value of [sharing?.name, sharing?.color])
		if (value !== undefined && typeof value !== "string")
			throw new TypeError("A selection name and color must be strings");
	const presence: Presence<SharedSelection> | undefined = sharing
		? joinPresence(pulse as Pulse<any>, RichTextSelection)
		: undefined;
	const draws = !!presence && sharing!.draw !== false;
	const owner = {};
	let disposed = false;
	// Presence only: sharing a selection never writes to the document.
	const publish = () => {
		if (!presence || disposed || !view.hasFocus) return;
		const { anchor, head } = view.state.selection.main;
		presence.set({
			anchor: field.anchorAt(anchor),
			head: field.anchorAt(head),
			name: sharing!.name ?? "",
			color: sharing!.color ?? "",
		});
		publishers.set(pulse as object, owner);
	};
	// A pulse has one selection per peer: another binding of the same pulse
	// may have shared its own since, and that one must stay.
	const withdraw = () => {
		if (publishers.get(pulse as object) !== owner) return;
		publishers.delete(pulse as object);
		presence?.set(undefined);
	};
	// Set while this binding edits the field, so it does not answer itself.
	let writing = false;
	const write = (edit: () => void) => {
		writing = true;
		try {
			edit();
		} finally {
			writing = false;
		}
	};
	// ponytail: compares whole documents on every pulse change, O(length); apply the field's own deltas if large files need it.
	const pull = () => {
		if (writing) return;
		// CodeMirror counts every line break as one "\n": keep the field in that form.
		write(() => {
			for (let i; (i = field.text.indexOf("\r")) >= 0;)
				field.replace(i, 1, field.text[i + 1] === "\n" ? "" : "\n");
		});
		const next = field.text,
			current = view.state.doc.toString();
		if (next === current) return;
		// One change over the differing middle: selections map through it.
		const limit = Math.min(next.length, current.length);
		let start = 0;
		while (start < limit && next[start] === current[start]) start++;
		let tail = 0;
		while (
			tail < limit - start &&
			next[next.length - 1 - tail] === current[current.length - 1 - tail]
		)
			tail++;
		view.dispatch({
			changes: {
				from: start,
				to: current.length - tail,
				insert: next.slice(start, next.length - tail),
			},
			annotations: [remote.of(true), Transaction.addToHistory.of(false)],
		});
	};
	const extensions: Extension[] = [
		EditorView.updateListener.of((update) => {
			const local =
				update.docChanged &&
				!update.transactions.some((transaction) =>
					transaction.annotation(remote),
				);
			if (local)
				// `fromB` is where a change starts once the earlier ones are applied.
				write(() =>
					update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) =>
						field.replace(fromB, toA - fromA, inserted.toString()),
					),
				);
			if (!presence) return;
			if (update.focusChanged && !view.hasFocus) withdraw();
			else if (update.focusChanged || update.selectionSet || local) publish();
		}),
	];
	if (draws)
		extensions.push(peersPlugin(field, pulse as Pulse<any>, presence!));
	const listener = new Compartment();
	view.dispatch({
		effects: StateEffect.appendConfig.of(listener.of(extensions)),
	});
	pull();
	const unsubscribe = subscribe(pull);
	// Redraw through a transaction that changes neither the document nor the
	// selection, when the others change: setting mine also calls back, during
	// an editor update that must not dispatch.
	let drawn = presence?.others;
	const stopDrawing = draws
		? presence!.subscribe(({ others }) => {
				if (disposed || others === drawn) return;
				drawn = others;
				view.dispatch({ effects: redrawEffect.of(null) });
			})
		: undefined;
	publish();
	return {
		destroy() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			stopDrawing?.();
			withdraw();
			presence?.leave();
			view.dispatch({ effects: listener.reconfigure([]) });
		},
	};
}

/** The carets and ranges of the other peers, resolved from their anchors. */
function peersPlugin(
	field: PlainText,
	pulse: Pulse<any>,
	presence: Presence<SharedSelection>,
) {
	const build = (
		view: EditorView,
		held: ReturnType<typeof heldSelections<SharedSelection, [number, number]>>,
	): DecorationSet => {
		const size = view.state.doc.length;
		const decorations: Range<Decoration>[] = [];
		// A peer whose characters have not arrived yet keeps its last selection.
		for (const {
			peer,
			state,
			resolved: [anchor, head],
		} of held.resolve(presence.others)) {
			const color = safeColor.test(state.color) ? state.color : peerColor(peer);
			const from = Math.min(anchor, head, size),
				to = Math.min(Math.max(anchor, head), size);
			if (from < to)
				decorations.push(
					Decoration.mark({
						attributes: {
							style: `background-color: color-mix(in srgb, ${color} 25%, transparent)`,
							"data-peer-selection": String(peer),
						},
					}).range(from, to),
				);
			decorations.push(
				Decoration.widget({
					widget: new Caret(peer, color, state.name),
					// On the left of text typed at its position, as its anchor is.
					side: -1,
				}).range(Math.min(head, size)),
			);
		}
		return Decoration.set(decorations, true);
	};
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			held = heldSelections(
				pulse,
				(state: SharedSelection) => {
					const anchor = field.indexOf(state.anchor),
						head = field.indexOf(state.head);
					// Another field, or a character that has not arrived yet.
					return anchor === undefined || head === undefined
						? undefined
						: ([anchor, head] as [number, number]);
				},
				() => this.view.dispatch({ effects: redrawEffect.of(null) }),
			);
			constructor(readonly view: EditorView) {
				this.decorations = build(view, this.held);
			}
			destroy() {
				this.held.destroy();
			}
			update(update: ViewUpdate) {
				// A local edit reaches the field after this update: move what is drawn,
				// the next remote change or presence frame resolves the anchors again.
				const local =
					update.docChanged &&
					!update.transactions.some((transaction) =>
						transaction.annotation(remote),
					);
				this.decorations = local
					? this.decorations.map(update.changes)
					: build(update.view, this.held);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

class Caret extends WidgetType {
	constructor(
		readonly peer: number,
		readonly color: string,
		readonly name: string,
	) {
		super();
	}
	override eq(other: Caret) {
		return (
			other.peer === this.peer &&
			other.color === this.color &&
			other.name === this.name
		);
	}
	toDOM(view: EditorView) {
		const document = view.dom.ownerDocument;
		const caret = document.createElement("span");
		caret.setAttribute("data-peer", String(this.peer));
		caret.style.cssText = `position: relative; margin: 0 -1px; border-left: 2px solid ${this.color}; pointer-events: none;`;
		if (this.name) {
			const label = caret.appendChild(document.createElement("span"));
			label.textContent = this.name;
			label.style.cssText = `position: absolute; bottom: 100%; left: -2px; padding: 0 4px; background-color: ${this.color}; color: #fff; font: 600 11px/1.4 system-ui, sans-serif; white-space: nowrap; user-select: none;`;
		}
		return caret;
	}
	override ignoreEvent() {
		return true;
	}
}

/** A stable color for a peer that shares none: a hue from its number. */
const peerColor = (peer: number): string =>
	`hsl(${(peer * 137) % 360}, 70%, 45%)`;
// A color comes from another peer and goes into a style: it must not be able
// to end its declaration.
const safeColor = /^[#\w .,%()/-]{1,64}$/;
